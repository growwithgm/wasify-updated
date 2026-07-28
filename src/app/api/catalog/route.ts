import { withAuth } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return withAuth(async ({ supabase }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim()

    let products = supabase
      .from('shopify_products')
      .select('*', { count: 'exact' })
      .order('title')
      .limit(100)

    if (q) products = products.or(`title.ilike.%${q}%,sku.ilike.%${q}%,vendor.ilike.%${q}%`)

    const [productsRes, cartsRes, ordersRes, configRes, discountsRes, codesRes] = await Promise.all([
      products,
      supabase
        .from('chat_carts')
        .select('*, contacts:contact_id (name, phone)')
        .order('updated_at', { ascending: false })
        .limit(20),
      supabase
        .from('shopify_orders')
        .select('id, order_number, customer_name, total_price, currency, financial_status, is_cod, shopify_created_at')
        .order('shopify_created_at', { ascending: false })
        .limit(15),
      supabase.from('shopify_config').select('store_domain, store_name, last_sync_at, connection_status, scopes').maybeSingle(),
      supabase.from('discounts').select('*').order('created_at', { ascending: false }),
      supabase
        .from('discount_codes')
        .select('*, contacts:contact_id (name, phone)')
        .order('created_at', { ascending: false })
        .limit(30),
    ])

    return {
      products: productsRes.data ?? [],
      productCount: productsRes.count ?? 0,
      carts: cartsRes.data ?? [],
      orders: ordersRes.data ?? [],
      config: configRes.data,
      discounts: discountsRes.data ?? [],
      codes: codesRes.data ?? [],
    }
  })
}
