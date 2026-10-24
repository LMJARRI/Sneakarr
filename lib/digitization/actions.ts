'use server'

import { revalidatePath } from 'next/cache'
import { getAdminClient } from '@/lib/auth'
import type { ActionResult } from '@/lib/admin/product-actions'
import {
  ALLOWED_PHOTO_TYPES,
  CAPTURES_BUCKET,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  MIN_PHOTOS,
  MODELS_BUCKET,
  RESULTS_BUCKET,
  pickProviderPhotoIndexes,
  type JobMode,
} from '@/lib/digitization/config'
import { loadJob, sortedPhotos, UUID } from '@/lib/digitization/jobs'
import { createMeshyTask, deleteMeshyTask, isGlbBuffer, isMeshyConfigured, ProviderError } from '@/lib/digitization/meshy'

const MAX_CONCURRENT_PROVIDER_JOBS = 3
const PROVIDER_URL_TTL_SECONDS = 60 * 60
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

interface CreateJobInput {
  productId: string | null
  color: string | null
  mode: JobMode
  simulateFailure: boolean
  files: { type: string; size: number }[]
}

async function validateTarget(
  supabase: NonNullable<Awaited<ReturnType<typeof getAdminClient>>['supabase']>,
  productId: string | null,
  color: string | null,
): Promise<{ ok: true; color: string | null } | { ok: false; error: string }> {
  if (!productId) return color ? { ok: false, error: 'Elegí un producto antes de elegir un color.' } : { ok: true, color: null }
  if (!UUID.test(productId)) return { ok: false, error: 'Producto inválido.' }

  const { data: product } = await supabase
    .from('products')
    .select('id, variants:product_variants (color)')
    .eq('id', productId)
    .maybeSingle()
  if (!product) return { ok: false, error: 'El producto no existe.' }

  const trimmed = color?.trim() || null
  if (!trimmed) return { ok: true, color: null }
  const colors = ((product.variants ?? []) as { color: string }[]).map((v) => v.color.trim().toLowerCase())
  if (!colors.includes(trimmed.toLowerCase())) return { ok: false, error: 'Ese color no existe en las variantes del producto.' }
  return { ok: true, color: trimmed }
}

/** Crea el trabajo y devuelve URLs firmadas de subida para rutas controladas por el servidor. */
export async function createDigitizationJob(
  input: CreateJobInput,
): Promise<ActionResult<{ jobId: string; uploads: { path: string; token: string }[] }>> {
  const { supabase, error } = await getAdminClient()
  if (!supabase) return { ok: false, error }

  if (input.mode !== 'meshy' && input.mode !== 'test') return { ok: false, error: 'Modo inválido.' }
  if (input.mode === 'meshy' && !isMeshyConfigured()) {
    return { ok: false, error: 'Meshy no está configurado. Agregá MESHY_API_KEY o usá el modo prueba.' }
  }

  const files = Array.isArray(input.files) ? input.files : []
  if (files.length < MIN_PHOTOS || files.length > MAX_PHOTOS) {
    return { ok: false, error: `Subí entre ${MIN_PHOTOS} y ${MAX_PHOTOS} fotos.` }
  }
  for (const file of files) {
    if (!ALLOWED_PHOTO_TYPES.includes(file.type as (typeof ALLOWED_PHOTO_TYPES)[number])) {
      return { ok: false, error: 'Solo se aceptan fotos JPG, PNG o WebP.' }
    }
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
      return { ok: false, error: 'Cada foto debe pesar como máximo 10 MB.' }
    }
  }

  const target = await validateTarget(supabase, input.productId, input.color)
  if (!target.ok) return target

  const { data: job, error: jobError } = await supabase
    .from('digitization_jobs')
    .insert({
      product_id: input.productId,
      color: target.color,
      mode: input.mode,
      simulate_failure: input.mode === 'test' && input.simulateFailure === true,
      status: 'uploading',
    })
    .select('id')
    .single()
  if (jobError || !job) {
    console.error('[digitization] create job:', jobError?.message)
    return { ok: false, error: 'No se pudo crear el trabajo de digitalización.' }
  }

  const rows = files.map((file, i) => ({
    job_id: job.id,
    storage_path: `jobs/${job.id}/${String(i).padStart(2, '0')}-${crypto.randomUUID()}.${EXTENSIONS[file.type]}`,
    mime_type: file.type,
    size_bytes: file.size,
    sort_order: i,
  }))
  const { error: photosError } = await supabase.from('digitization_photos').insert(rows)
  if (photosError) {
    console.error('[digitization] insert photos:', photosError.message)
    await supabase.from('digitization_jobs').delete().eq('id', job.id)
    return { ok: false, error: 'No se pudieron registrar las fotos.' }
  }

  const uploads: { path: string; token: string }[] = []
  for (const row of rows) {
    const { data, error: signError } = await supabase.storage.from(CAPTURES_BUCKET).createSignedUploadUrl(row.storage_path)
    if (signError || !data) {
      console.error('[digitization] signed upload:', signError?.message)
      await supabase.from('digitization_jobs').delete().eq('id', job.id)
      return { ok: false, error: 'No se pudo preparar la subida de fotos.' }
    }
    uploads.push({ path: row.storage_path, token: data.token })
  }

  revalidatePath('/admin/digitalizacion')
  return { ok: true, data: { jobId: job.id, uploads } }
}

/** Verifica en Storage que todas las fotos existan con el tamaño y tipo declarados. */
export async function completeUpload(jobId: string): Promise<ActionResult> {
  const { supabase, error } = await getAdminClient()
  if (!supabase) return { ok: false, error }

  const job = await loadJob(supabase, jobId)
  if (!job) return { ok: false, error: 'El trabajo no existe.' }
  if (job.status !== 'uploading') return { ok: true, data: undefined }

  const { data: objects, error: listError } = await supabase.storage
    .from(CAPTURES_BUCKET)
    .list(`jobs/${jobId}`, { limit: 100 })
  if (listError) return { ok: false, error: 'No se pudieron verificar las fotos subidas.' }

  const byName = new Map((objects ?? []).map((o) => [o.name, o]))
  const { data: photos } = await supabase
    .from('digitization_photos')
    .select('storage_path, mime_type, size_bytes')
    .eq('job_id', jobId)
  for (const photo of photos ?? []) {
    const object = byName.get(photo.storage_path.split('/').pop() ?? '')
    const size = Number(object?.metadata?.size ?? 0)
    const mime = object?.metadata?.mimetype
    if (!object || size <= 0 || size > MAX_PHOTO_BYTES || (mime && mime !== photo.mime_type)) {
      return { ok: false, error: 'Alguna foto no se subió correctamente. Reintentá la subida.' }
    }
  }

  await supabase.from('digitization_jobs').update({ status: 'pending' }).eq('id', jobId).eq('status', 'uploading')
  return { ok: true, data: undefined }
}

/** Inicia (o reintenta) la generación. El cambio de estado condicional evita duplicados por doble clic. */
export async function startGeneration(jobId: string): Promise<ActionResult> {
  const { supabase, error } = await getAdminClient()
  if (!supabase) return { ok: false, error }

  const job = await loadJob(supabase, jobId)
  if (!job) return { ok: false, error: 'El trabajo no existe.' }
  if (job.status === 'processing') return { ok: false, error: 'El trabajo ya se está procesando.' }
  if (job.status !== 'pending' && job.status !== 'failed') {
    return { ok: false, error: 'Este trabajo no se puede iniciar en su estado actual.' }
  }
  if (job.status === 'failed' && !job.error_retryable && job.mode === 'meshy' && !isMeshyConfigured()) {
    return { ok: false, error: 'Configurá MESHY_API_KEY antes de reintentar.' }
  }

  const photos = sortedPhotos(job)
  if (photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS) {
    return { ok: false, error: `El trabajo necesita entre ${MIN_PHOTOS} y ${MAX_PHOTOS} fotos.` }
  }

  if (job.mode === 'meshy') {
    if (!isMeshyConfigured()) return { ok: false, error: 'Meshy no está configurado. Agregá MESHY_API_KEY.' }
    const { count } = await supabase
      .from('digitization_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'processing')
      .eq('mode', 'meshy')
    if ((count ?? 0) >= MAX_CONCURRENT_PROVIDER_JOBS) {
      return { ok: false, error: `Ya hay ${MAX_CONCURRENT_PROVIDER_JOBS} trabajos en proceso. Esperá a que terminen.` }
    }
  }

  const { data: claimed } = await supabase
    .from('digitization_jobs')
    .update({
      status: 'processing',
      progress: 0,
      attempts: job.attempts + 1,
      provider_task_id: null,
      error_message: null,
      error_retryable: true,
      result_path: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    })
    .eq('id', jobId)
    .in('status', ['pending', 'failed'])
    .select('id')
  if (!claimed?.length) return { ok: false, error: 'El trabajo ya se está procesando.' }

  if (job.mode === 'meshy') {
    const chosen = pickProviderPhotoIndexes(photos.length).map((i) => photos[i].storage_path)
    const { data: signed, error: signError } = await supabase.storage
      .from(CAPTURES_BUCKET)
      .createSignedUrls(chosen, PROVIDER_URL_TTL_SECONDS)
    const urls = (signed ?? []).map((s) => s.signedUrl).filter((u): u is string => Boolean(u))

    let failure: ProviderError | null = null
    if (signError || urls.length !== chosen.length) {
      failure = new ProviderError('No se pudieron preparar las fotos para el proveedor.', true)
    } else {
      try {
        const taskId = await createMeshyTask(urls)
        await supabase.from('digitization_jobs').update({ provider_task_id: taskId }).eq('id', jobId)
      } catch (e) {
        failure = e instanceof ProviderError ? e : new ProviderError('Error inesperado al crear el trabajo en Meshy.', true)
      }
    }
    if (failure) {
      await supabase
        .from('digitization_jobs')
        .update({
          status: 'failed',
          error_message: failure.message,
          error_retryable: failure.retryable,
          finished_at: new Date().toISOString(),
        })
        .eq('id', jobId)
      return { ok: false, error: failure.message }
    }
  }

  return { ok: true, data: undefined }
}

/** Asocia el GLB revisado al producto: lo copia al bucket público, verifica que cargue y crea el registro. */
export async function confirmJob(
  jobId: string,
  input: { productId: string; color: string | null },
): Promise<ActionResult<{ modelUrl: string }>> {
  const { supabase, error } = await getAdminClient()
  if (!supabase) return { ok: false, error }

  const job = await loadJob(supabase, jobId)
  if (!job) return { ok: false, error: 'El trabajo no existe.' }
  if (job.mode === 'test') {
    return { ok: false, error: 'Los resultados del modo prueba no son modelos reales y no se pueden asociar a productos.' }
  }
  if (job.status !== 'completed' || !job.result_path) return { ok: false, error: 'El trabajo todavía no tiene un modelo listo.' }
  if (!input.productId) return { ok: false, error: 'Elegí el producto al que pertenece el modelo.' }

  const target = await validateTarget(supabase, input.productId, input.color)
  if (!target.ok) return target

  const { data: claimed } = await supabase
    .from('digitization_jobs')
    .update({ status: 'confirmed', product_id: input.productId, color: target.color })
    .eq('id', jobId)
    .eq('status', 'completed')
    .select('id')
  if (!claimed?.length) return { ok: false, error: 'El trabajo ya fue confirmado o descartado.' }

  const revert = (message: string) =>
    supabase
      .from('digitization_jobs')
      .update({ status: 'completed' })
      .eq('id', jobId)
      .then(() => ({ ok: false as const, error: message }))

  const { data: blob, error: downloadError } = await supabase.storage.from(RESULTS_BUCKET).download(job.result_path)
  if (downloadError || !blob) return revert('No se encontró el modelo generado en Storage.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!isGlbBuffer(bytes)) return revert('El archivo guardado no es un GLB válido.')

  const publicPath = `products/${input.productId}/${jobId}.glb`
  const { error: uploadError } = await supabase.storage
    .from(MODELS_BUCKET)
    .upload(publicPath, bytes, { contentType: 'model/gltf-binary', upsert: true })
  if (uploadError) {
    console.error('[digitization] publish model:', uploadError.message)
    return revert('No se pudo guardar el modelo final.')
  }

  const { data: publicUrl } = supabase.storage.from(MODELS_BUCKET).getPublicUrl(publicPath)
  const modelUrl = publicUrl.publicUrl
  try {
    const head = await fetch(modelUrl, { headers: { Range: 'bytes=0-3' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    const magic = new Uint8Array(await head.arrayBuffer()).slice(0, 4)
    if (!head.ok || String.fromCharCode(...magic) !== 'glTF') return revert('El modelo final no se pudo cargar desde Storage.')
  } catch {
    return revert('No se pudo verificar que el modelo final cargue correctamente.')
  }

  const { data: model, error: modelError } = await supabase
    .from('product_models')
    .insert({
      product_id: input.productId,
      color: target.color,
      glb_url: modelUrl,
      status: 'completed',
      provider: 'meshy',
      provider_task_id: job.provider_task_id,
    })
    .select('id')
    .single()
  if (modelError || !model) {
    console.error('[digitization] insert model:', modelError?.message)
    return revert('No se pudo registrar el modelo en el producto.')
  }

  await supabase.from('digitization_jobs').update({ model_id: model.id }).eq('id', jobId)
  revalidatePath('/admin/digitalizacion')
  revalidatePath('/admin/productos')
  revalidatePath('/')
  revalidatePath('/catalogo')
  revalidatePath('/producto/[slug]', 'page')
  return { ok: true, data: { modelUrl } }
}

/** Descarta el trabajo y borra sus archivos. Si sigue en cola en Meshy se intenta cancelar. */
export async function discardJob(jobId: string): Promise<ActionResult> {
  const { supabase, error } = await getAdminClient()
  if (!supabase) return { ok: false, error }

  const job = await loadJob(supabase, jobId)
  if (!job) return { ok: false, error: 'El trabajo no existe.' }
  if (job.status === 'confirmed') return { ok: false, error: 'Un trabajo confirmado no se puede descartar.' }
  if (job.status === 'discarded') return { ok: true, data: undefined }

  const { data: claimed } = await supabase
    .from('digitization_jobs')
    .update({ status: 'discarded', finished_at: new Date().toISOString() })
    .eq('id', jobId)
    .neq('status', 'confirmed')
    .select('id')
  if (!claimed?.length) return { ok: false, error: 'No se pudo descartar el trabajo.' }

  if (job.mode === 'meshy' && job.provider_task_id && isMeshyConfigured()) await deleteMeshyTask(job.provider_task_id)
  const photoPaths = sortedPhotos(job).map((p) => p.storage_path)
  if (photoPaths.length) await supabase.storage.from(CAPTURES_BUCKET).remove(photoPaths)
  if (job.result_path) await supabase.storage.from(RESULTS_BUCKET).remove([job.result_path])

  revalidatePath('/admin/digitalizacion')
  return { ok: true, data: undefined }
}
