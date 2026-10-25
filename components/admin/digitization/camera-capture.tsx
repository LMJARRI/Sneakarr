'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Check, Loader2, SwitchCamera, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

const MAX_SIDE = 2048

type Facing = 'environment' | 'user'
type CameraState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

interface CameraCaptureProps {
  open: boolean
  remaining: number
  onCapture: (file: File) => void
  onClose: () => void
  /** Abre la cámara nativa del sistema (input con capture). Debe llamarse desde un gesto del usuario. */
  onOpenNativeCamera: () => void
}

function describeError(error: unknown): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'La cámara solo funciona en una conexión segura (https).'
  }
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'El permiso de cámara fue bloqueado. Habilitalo en los ajustes del navegador o usá la cámara del celular.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró una cámara en este dispositivo.'
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'La cámara está siendo usada por otra aplicación. Cerrala y volvé a intentar.'
  }
  return 'No se pudo abrir la cámara en esta pantalla.'
}

async function requestStream(facing: Facing): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    })
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw error
    // Algunos dispositivos rechazan las restricciones de resolución: se reintenta con las mínimas.
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false })
  }
}

export function CameraCapture({ open, remaining, onCapture, onClose, onOpenNativeCamera }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>({ kind: 'loading' })
  const [facing, setFacing] = useState<Facing>('environment')
  const [taken, setTaken] = useState(0)
  const [flash, setFlash] = useState(false)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    if (open) setTaken(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ kind: 'loading' })

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({ kind: 'error', message: describeError(null) })
        return
      }
      try {
        const stream = await requestStream(facing)
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }))
        }
        await video.play().catch(() => undefined)
        if (!cancelled) setState({ kind: 'ready' })
      } catch (error) {
        if (!cancelled) setState({ kind: 'error', message: describeError(error) })
      }
    }

    start()
    return () => {
      cancelled = true
      stopStream()
    }
  }, [open, facing, stopStream])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  function takePhoto() {
    const video = videoRef.current
    if (!video || state.kind !== 'ready' || !video.videoWidth || taken >= remaining) return
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        onCapture(new File([blob], `captura-${Date.now()}.jpg`, { type: 'image/jpeg' }))
        setTaken((n) => n + 1)
        setFlash(true)
        window.setTimeout(() => setFlash(false), 120)
        navigator.vibrate?.(30)
      },
      'image/jpeg',
      0.9,
    )
  }

  function openNativeCamera() {
    stopStream()
    onOpenNativeCamera()
  }

  if (!open) return null

  const full = taken >= remaining
  const ready = state.kind === 'ready'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cámara para digitalización 3D"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <div className="relative min-h-0 flex-1 bg-foreground/95">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={state.kind === 'error' ? 'hidden' : 'size-full object-contain'}
        />

        {state.kind === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-background">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Abriendo la cámara…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-background">
            <CameraOff className="size-10" aria-hidden="true" />
            <p className="max-w-sm text-pretty text-sm leading-relaxed" role="alert">
              {state.message}
            </p>
            <Button type="button" size="lg" onClick={openNativeCamera}>
              <Camera className="size-4" aria-hidden="true" />
              Abrir cámara del celular
            </Button>
          </div>
        )}

        {ready && (
          <div
            className="pointer-events-none absolute inset-x-6 top-1/2 aspect-[2/1] -translate-y-1/2 rounded-2xl border-2 border-dashed border-background/60"
            aria-hidden="true"
          />
        )}

        {flash && <div className="absolute inset-0 bg-background/70" aria-hidden="true" />}

        <div className="absolute top-4 right-4 left-4 flex items-center justify-between gap-2">
          <p className="rounded-full bg-foreground/70 px-3 py-1 text-xs font-medium text-background">
            {taken === 0 ? 'Empezá por el frente' : 'Girá alrededor de la zapatilla'}
          </p>
          <Button type="button" size="icon" variant="secondary" onClick={onClose} aria-label="Cerrar la cámara">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex min-w-24 items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
            disabled={state.kind === 'loading'}
            aria-label="Cambiar de cámara"
          >
            <SwitchCamera className="size-4" aria-hidden="true" />
          </Button>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {full ? 'Máximo' : `${taken} ${taken === 1 ? 'foto' : 'fotos'}`}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          className="size-16 rounded-full"
          onClick={takePhoto}
          disabled={!ready || full}
          aria-label="Sacar foto"
        >
          <Camera className="size-6" aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" className="min-w-24" onClick={onClose}>
          <Check className="size-4" aria-hidden="true" />
          Listo
        </Button>
      </div>
    </div>
  )
}
