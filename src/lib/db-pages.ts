/**
 * Every row a query matches, walked in 1,000-row pages.
 *
 * PostgREST silently caps any response at 1,000 rows. A merchant with 1,700
 * contacts who trusts a plain select('*') gets 1,000 of them and no error —
 * segments quietly miss members, audiences quietly shrink. Two rules here:
 * page until a short page says we're done, and THROW on error instead of
 * returning what we have, because a partial audience that looks complete is
 * worse than a loud failure.
 *
 * The query must carry a stable .order(...) — the caller's page callback
 * adds it — or rows can repeat/vanish between pages.
 */
export async function allPages(makePage: (from: number, to: number) => any): Promise<any[]> {
  const PAGE = 1000
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makePage(from, from + PAGE - 1)
    if (error) throw new Error(`Query failed: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}
