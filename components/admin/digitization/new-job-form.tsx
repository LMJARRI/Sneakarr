'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Check, ImagePlus, KeyRound, Loader2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Panel } from '@/components/admin/admin-ui'
import { CameraCapture } from '@/components/admin/digitization/camera-capture'
import type { ProductOption } from '@/components/admin/digitization/digitization-workspace'
import { TargetSelects } from '@/components/admin/digitization/target-selects'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { createClient } from '@/lib/supabase/client'
import { completeUpload, createDigitizationJob, discardJob, startGeneration } from '@/lib/digitization/actions'
import {
  ALLOWED_PHOTO_TYPES,
  CAPTURES_BUCKET,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  MIN_PHOTOS,
  PROVIDER_MAX_IMAGES,
  type JobMode,
} from '@/lib/digitization/config'
import { cn } from '@/lib/utils'

interface Photo {
  id: string
  file: File
  url: string
}

function rejectionReason(file: File): string | null {
  if (!ALLOWED_PHOTO_TYPES.includes(file.type as (typeof ALLOWED_PHOTO_TYPES)[number])) return 'formato no admitido'
  if (file.size > MAX_PHOTO_BYTES) return 'supera 10 MB'
  return null
}

export function NewJobForm({
  products,
  providerConfigured,
  onCreated,
}: {
  products: ProductOption[]
  providerConfigured: boolean
  onCreated: (jobId: string) => void
}) {
  const [productId, setProductId] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [mode, setMode] = useState<JobMode>(providerConfigured ? 'meshy' : 'test')
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const busyRef = useRef(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const replaceTarget = useRef<string | null>(null)
  const photosRef = useRef(photos)
  photosRef.current = photos

  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), [])

  const closeCamera = useCallback(() => setCameraOpen(false), [])

  // Se invoca desde un clic: los navegadores móviles solo abren el input de cámara con un gesto del usuario.
  const openNativeCamera = useCallback(() => {
    cameraRef.current?.click()
    setCameraOpen(false)
  }, [])

  function addFiles(files: FileList | File[] | null) {
    if (!files?.length) return
    const rejected: string[] = []
    const accepted: Photo[] = []
    for (const file of Array.from(files)) {
      const reason = rejectionReason(file)
      if (reason) rejected.push(`${file.name}: ${reason}`)
      else accepted.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) })
    }
    const room = MAX_PHOTOS - photosRef.current.length
    accepted.slice(room).forEach((p) => URL.revokeObjectURL(p.url))
    if (accepted.length > room) toast.warning(`Se agregaron ${Math.max(room, 0)} fotos: el máximo es ${MAX_PHOTOS}.`)
    setPhotos((list) => [...list, ...accepted.slice(0, room)])
    if (rejected.length) {
      toast.error('Algunas fotos se descartaron', { description: `${rejected.join(' · ')}. Solo JPG, PNG o WebP de hasta 10 MB.` })
    }
  }

  function replacePhoto(files: FileList | null) {
    const file = files?.[0]
    const targetId = replaceTarget.current
    if (!file || !targetId) return
    const reason = rejectionReason(file)
    if (reason) {
      toast.error(`No se puede usar ${file.name}: ${reason}.`)
      return
    }
    setPhotos((list) =>
      list.map((p) => {
        if (p.id !== targetId) return p
        URL.revokeObjectURL(p.url)
        return { id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }
      }),
    )
  }

  function removePhoto(id: string) {
    setPhotos((list) => {
      const target = list.find((p) => p.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return list.filter((p) => p.id !== id)
    })
  }

  const enoughPhotos = photos.length >= MIN_PHOTOS && photos.length <= MAX_PHOTOS
  const modeReady = mode === 'test' || providerConfigured
  const canSubmit = enoughPhotos && modeReady && !busy

  async function submit() {
    if (busyRef.current || !canSubmit) return
    busyRef.current = true
    let jobId: string | null = null
    try {
      setBusy('Creando el trabajo…')
      const created = await createDigitizationJob({
        productId,
        color,
        mode,
        simulateFailure,
        files: photos.map((p) => ({ type: p.file.type, size: p.file.size })),
      })
      if (!created.ok) throw new Error(created.error)
      jobId = created.data.jobId

      const supabase = createClient()
      for (const [i, upload] of created.data.uploads.entries()) {
        setBusy(`Subiendo imágenes (${i + 1}/${photos.length})…`)
        const { error } = await supabase.storage
          .from(CAPTURES_BUCKET)
          .uploadToSignedUrl(upload.path, upload.token, photos[i].file, { contentType: photos[i].file.type })
        if (error) throw new Error('No se pudo subir una de las fotos. Revisá tu conexión y reintentá.')
      }

      setBusy('Verificando fotos…')
      const verified = await completeUpload(jobId)
      if (!verified.ok) throw new Error(verified.error)

      setBusy('Iniciando la generación…')
      const started = await startGeneration(jobId)
      photos.forEach((p) => URL.revokeObjectURL(p.url))
      setPhotos([])
      if (started.ok) toast.success('Generación iniciada. Podés salir de esta pantalla: el trabajo sigue guardado.')
      else toast.error('Las fotos se guardaron, pero la generación no pudo iniciar', { description: started.error })
      onCreated(jobId)
    } catch (error) {
      if (jobId) await discardJob(jobId)
      toast.error(error instanceof Error ? error.message : 'No se pudo crear el trabajo.')
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const checks = [
    { ok: photos.length >= MIN_PHOTOS, label: `Al menos ${MIN_PHOTOS} fotos` },
    { ok: photos.length <= MAX_PHOTOS, label: `Como máximo ${MAX_PHOTOS} fotos` },
    { ok: true, label: 'JPG, PNG o WebP de hasta 10 MB (validado al agregar)' },
    { ok: modeReady, label: mode === 'test' ? 'Modo prueba seleccionado' : 'Proveedor Meshy configurado' },
  ]

  return (
    <div className="flex flex-col gap-5">
      <CameraCapture
        open={cameraOpen}
        remaining={MAX_PHOTOS - photos.length}
        onCapture={(file) => addFiles([file])}
        onClose={closeCamera}
        onOpenNativeCamera={openNativeCamera}
      />
      <Panel className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-semibold">Producto</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Opcional por ahora: podés asociar el modelo a un producto y color cuando lo confirmes.
          </p>
        </div>
        <TargetSelects
          products={products}
          productId={productId}
          color={color}
          onProductChange={(id) => {
            setProductId(id)
            setColor(null)
          }}
          onColorChange={setColor}
          optionalProduct
        />
      </Panel>

      <Panel className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold">
            Fotos{' '}
            <span className="text-muted-foreground">
              ({photos.length}/{MAX_PHOTOS})
            </span>
          </h2>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setCameraOpen(true)} disabled={photos.length >= MAX_PHOTOS || !!busy}>
              <Camera className="size-4" aria-hidden="true" />
              Tomar foto
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => galleryRef.current?.click()}
              disabled={photos.length >= MAX_PHOTOS || !!busy}
            >
              <ImagePlus className="size-4" aria-hidden="true" />
              Subir
            </Button>
          </div>
          {[
            { ref: cameraRef, capture: true, multiple: false, handler: addFiles },
            { ref: galleryRef, capture: false, multiple: true, handler: addFiles },
            { ref: replaceRef, capture: false, multiple: false, handler: replacePhoto },
          ].map(({ ref, capture, multiple, handler }, i) => (
            <input
              key={i}
              ref={ref}
              type="file"
              accept={capture ? 'image/*' : ALLOWED_PHOTO_TYPES.join(',')}
              capture={capture ? 'environment' : undefined}
              multiple={multiple}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                handler(e.target.files)
                e.target.value = ''
              }}
            />
          ))}
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(100, (photos.length / MIN_PHOTOS) * 100)}%` }}
          />
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground" aria-live="polite">
          {photos.length >= MIN_PHOTOS
            ? `Listo. Se envían al proveedor ${Math.min(photos.length, PROVIDER_MAX_IMAGES)} fotos repartidas entre todos los ángulos (la primera como frente); todas quedan guardadas.`
            : `Faltan ${MIN_PHOTOS - photos.length} fotos para el mínimo (${MIN_PHOTOS}).`}
        </p>

        {photos.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo, i) => (
              <li key={photo.id} className="flex flex-col gap-2">
                <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local blob previews */}
                  <img src={photo.url} alt={`Foto ${i + 1}`} className="size-full object-cover" />
                  <span className="absolute top-2 left-2 rounded-full bg-background/90 px-2 py-0.5 text-xs font-semibold text-foreground">
                    {i === 0 ? 'Frente' : i + 1}
                  </span>
                </div>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    disabled={!!busy}
                    onClick={() => {
                      replaceTarget.current = photo.id
                      replaceRef.current?.click()
                    }}
                    aria-label={`Reemplazar foto ${i + 1}`}
                  >
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                    Cambiar
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => removePhoto(photo.id)}
                    aria-label={`Eliminar foto ${i + 1}`}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <Camera className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Desde el celular, «Tomar foto» abre la cámara trasera. Entre {MIN_PHOTOS} y {MAX_PHOTOS} fotos.
            </p>
          </div>
        )}
      </Panel>

      <Panel className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-semibold">Generación</h2>
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!!busy}>
          <legend className="sr-only">Modo de generación</legend>
          <label
            className={cn(
              'flex cursor-pointer flex-col gap-1 rounded-xl border border-border p-4 has-[:checked]:border-primary has-[:checked]:bg-accent/40',
              !providerConfigured && 'cursor-not-allowed opacity-60',
            )}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="radio"
                name="mode"
                value="meshy"
                checked={mode === 'meshy'}
                disabled={!providerConfigured}
                onChange={() => setMode('meshy')}
                className="accent-primary"
              />
              Meshy · generación real
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Consume créditos de tu cuenta Meshy (requiere plan pago). Tarda varios minutos.
            </span>
          </label>
          <label className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border p-4 has-[:checked]:border-primary has-[:checked]:bg-accent/40">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="radio"
                name="mode"
                value="test"
                checked={mode === 'test'}
                onChange={() => setMode('test')}
                className="accent-primary"
              />
              Modo prueba
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Prueba el flujo sin proveedor. No genera un modelo real ni se puede publicar.
            </span>
          </label>
        </fieldset>

        {mode === 'test' && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={simulateFailure} onCheckedChange={(v) => setSimulateFailure(v === true)} />
            Simular un error en el primer intento (para probar «Reintentar»)
          </label>
        )}

        {!providerConfigured && (
          <div className="flex gap-3 rounded-xl border border-border bg-muted/60 p-4 text-sm leading-relaxed">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <p className="font-semibold">Meshy no está configurado</p>
              <p className="text-muted-foreground">
                Creá una API key en meshy.ai (Settings → API) con un plan que incluya créditos de API y agregala como{' '}
                <code className="rounded bg-background px-1 font-mono text-xs">MESHY_API_KEY</code> en Configuración → Vars.
                La clave solo se usa en el servidor.
              </p>
            </div>
          </div>
        )}

        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {checks.map((c) => (
            <li key={c.label} className={cn('flex items-center gap-2', c.ok ? 'text-foreground' : 'text-muted-foreground')}>
              {c.ok ? (
                <Check className="size-4 text-primary" aria-hidden="true" />
              ) : (
                <X className="size-4 text-destructive" aria-hidden="true" />
              )}
              <span>
                <span className="sr-only">{c.ok ? 'Cumplido: ' : 'Pendiente: '}</span>
                {c.label}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <Button size="lg" disabled={!canSubmit} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {busy ?? (mode === 'test' ? 'Subir fotos y probar flujo' : 'Subir fotos y generar modelo 3D')}
          </Button>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {busy ? 'No cierres la pantalla hasta que terminen de subirse las fotos.' : 'Las fotos se guardan en almacenamiento privado.'}
          </p>
        </div>
      </Panel>
    </div>
  )
}
