import Link from 'next/link'
import { connection } from 'next/server'
import { ArrowRight } from 'lucide-react'
import { BrandLinks } from '@/components/home/brand-links'
import { Hero } from '@/components/home/hero'
import { HowItWorks } from '@/components/home/how-it-works'
import { ProductGrid } from '@/components/products/product-grid'
import { getFeaturedProducts, getPublishedProducts } from '@/lib/products'

export default async function HomePage() {
  // Se renderiza por request: el build no depende de la base y los modelos 3D nuevos aparecen al instante.
  await connection()
  const [featured, published] = await Promise.all([getFeaturedProducts(4), getPublishedProducts()])

  const brandCounts = new Map<string, number>()
  for (const p of published) brandCounts.set(p.brand, (brandCounts.get(p.brand) ?? 0) + 1)
  const brands = [...brandCounts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="flex flex-col gap-20">
      <Hero />

      <section aria-labelledby="destacados" className="mx-auto w-full max-w-7xl px-4 md:px-6">
        <div className="mb-6 flex items-end justify-between gap-4">
          <h2 id="destacados" className="font-display text-3xl font-bold">
            Destacados
          </h2>
          <Link href="/catalogo" className="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            Ver todo
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <ProductGrid products={featured} />
      </section>

      <BrandLinks brands={brands} />
      <HowItWorks />
    </div>
  )
}
