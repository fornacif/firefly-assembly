// History of the activity of the users (template readings, crops, image generations, generations of variants), kept in the
// database of the workspace (App Builder Database Storage, region emea): one document per task, with the API calls it made.
// Kept without limit of time. Read by get-usage-history (the user's own generations) and get-usage-report (all the users, for the admins).
const libDb = require('@adobe/aio-lib-db')
const { generateAccessToken } = require('@adobe/aio-lib-core-auth')

// Region of the database, as provisioned (app.config.yaml)
const DB_REGION = 'emea'
const COLLECTION = 'activity'

// Environment of the workspace, from its Runtime namespace (<org>-<project>-<workspace>, without workspace for Production):
// each workspace has its own database, the dashboards say which one they show
function environment () {
  const workspace = String(process.env.__OW_NAMESPACE || '').split('-')[2]
  return workspace ? workspace.charAt(0).toUpperCase() + workspace.slice(1) : 'Production'
}

let indexed = false

// Runs fn(collection) on a connection to the database, closed after.
async function withActivity (params, fn) {
  const token = await generateAccessToken(params)
  const db = await libDb.init({ token: token.access_token, region: DB_REGION })
  const client = await db.connect()
  try {
    const collection = client.collection(COLLECTION)
    if (!indexed) {
      await collection.createIndex({ userId: 1, at: -1 })
      await collection.createIndex({ at: -1 })
      indexed = true
    }
    return await fn(collection)
  } finally {
    await client.close().catch(() => {})
  }
}

// Time during which at least one call waited for the rate limit, in ms: the periods of wait of the calls ([start, end]) joined,
// the calls waiting at once counting once (the delay of the task, unlike the sum of the waits)
function rateLimitDelay (calls) {
  const periods = calls.flatMap(call => call.waits || []).sort((a, b) => a[0] - b[0])
  let total = 0
  let end = -Infinity
  periods.forEach(([from, to]) => {
    if (to <= end) return
    total += to - Math.max(from, end)
    end = to
  })
  return total
}

// API calls of a task by kind: [{ api, operation, count, failed, totalMs, requests, rateLimited, waitMs }], rateLimited being the
// 429 answers and waitMs the time waited for the rate limit
function callsByKind (calls) {
  const kinds = new Map()
  calls.forEach(call => {
    const kind = kinds.get(call.operation) || { api: call.api, operation: call.operation, count: 0, failed: 0, totalMs: 0, requests: 0, rateLimited: 0, waitMs: 0 }
    kind.count++
    if (call.ok) kind.totalMs += call.ms; else kind.failed++
    kind.requests += call.requests || 0
    kind.rateLimited += call.rateLimited || 0
    kind.waitMs += call.waitMs || 0
    kinds.set(call.operation, kind)
  })
  return [...kinds.values()]
}

// Keeps the activity of a task: its kind, duration, API calls, and for a generation its variants, template, formats and
// languages. The activity is kept without limit of time.
async function recordActivity (params, task, { ok, durationMs, calls, result }) {
  const at = new Date()
  const day = at.toISOString().slice(0, 10)
  const renders = calls.filter(call => call.operation === 'Variant render' && call.ok)
  const generation = task.type === 'variants'
  const document = {
    userId: task.userId,
    kind: task.type,
    at,
    day,
    month: day.slice(0, 7),
    ok,
    durationMs,
    generations: generation && ok ? 1 : 0,
    variants: generation ? (result?.variants || []).filter(v => !v.error).length : 0,
    failed: generation ? (result?.variants || []).filter(v => v.error).length || (ok ? 0 : task.args.variants?.length || 0) : 0,
    apiCalls: calls.length,
    requests: calls.reduce((total, call) => total + (call.requests || 0), 0),
    rateLimited: calls.reduce((total, call) => total + (call.rateLimited || 0), 0),
    waitMs: calls.reduce((total, call) => total + (call.waitMs || 0), 0),
    rateLimitDelayMs: rateLimitDelay(calls),
    renders: renders.length,
    renderMs: renders.reduce((total, call) => total + call.ms, 0),
    calls: callsByKind(calls),
    ...(generation
      ? {
          template: result?.report?.template || null,
          formats: task.args.formats || [],
          languages: [...new Set((task.args.variants || []).map(v => v.language).filter(Boolean))]
        }
      : {}),
    ...(task.type === 'template' ? { template: result?.document?.title || null } : {})
  }
  await withActivity(params, activity => activity.insertOne(document))
}

// Filter of the activity over the last days, all of it without days
const period = days => days ? { at: { $gte: new Date(Date.now() - days * 86400000) } } : {}
// Numbers of the database: those beyond 32 bits come as BSON longs ({ low, high })
const num = value => value && typeof value === 'object' && 'low' in value ? value.high * 2 ** 32 + (value.low >>> 0) : Number(value || 0)
const average = (totalMs, count) => num(count) ? Math.round(num(totalMs) / num(count)) : null
const isoDate = value => new Date(value?.$date ?? value).toISOString()

const SUMS = { generations: { $sum: '$generations' }, variants: { $sum: '$variants' }, failed: { $sum: '$failed' }, apiCalls: { $sum: '$apiCalls' }, requests: { $sum: '$requests' }, rateLimited: { $sum: '$rateLimited' }, waitMs: { $sum: '$waitMs' }, rateLimitDelayMs: { $sum: '$rateLimitDelayMs' }, renders: { $sum: '$renders' }, renderMs: { $sum: '$renderMs' } }
const numbers = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'string' ? value : num(value)]))
const withAverage = ({ renders, renderMs, ...rest }) => ({ ...numbers(rest), averageRenderMs: average(renderMs, renders) })

// Names of the kinds of calls kept by earlier versions, read under their current name
const RENAMED_OPERATIONS = { 'Image generation': 'Image generation (Firefly)', 'Subject detection': 'Crop suggestion', 'Image crop': 'Image crop (Photoshop)' }

// Kinds of calls with their earlier names merged into their current one, the most made first
function mergeRenamed (operations) {
  const merged = new Map()
  operations.forEach(({ _id, api, ...sums }) => {
    const name = RENAMED_OPERATIONS[_id] || _id
    const kind = merged.get(name) || { _id: name, api, count: 0, failed: 0, totalMs: 0, requests: 0, rateLimited: 0, waitMs: 0 }
    Object.keys(sums).forEach(key => { kind[key] += num(sums[key]) })
    merged.set(name, kind)
  })
  return [...merged.values()].sort((a, b) => b.count - a.count)
}

// Usage of the activity matching a filter: totals, per day and per kind of API call.
async function usage (activity, filter) {
  const match = { $match: filter }
  const [totals, perDay, operations] = await Promise.all([
    activity.aggregate([match, { $group: { _id: null, users: { $addToSet: '$userId' }, ...SUMS } }]).toArray(),
    activity.aggregate([match, { $group: { _id: '$day', users: { $addToSet: '$userId' }, ...SUMS } }, { $sort: { _id: 1 } }]).toArray(),
    activity.aggregate([match, { $unwind: '$calls' }, {
      $group: { _id: '$calls.operation', api: { $first: '$calls.api' }, count: { $sum: '$calls.count' }, failed: { $sum: '$calls.failed' }, totalMs: { $sum: '$calls.totalMs' }, requests: { $sum: '$calls.requests' }, rateLimited: { $sum: '$calls.rateLimited' }, waitMs: { $sum: '$calls.waitMs' } }
    }, { $sort: { count: -1 } }]).toArray()
  ])
  const { _id, users = [], ...total } = totals[0] || {}
  return {
    totals: withAverage({ users: users.length, ...Object.fromEntries(Object.keys(SUMS).map(key => [key, total[key]])) }),
    perDay: perDay.map(({ _id, users, ...day }) => withAverage({ day: _id, users: users.length, ...day })),
    apiCalls: mergeRenamed(operations).map(({ _id, totalMs, ...op }) => ({ operation: _id, ...numbers(op), averageMs: average(totalMs, num(op.count) - num(op.failed)) }))
  }
}

// Usage of a user over the last days (all of it without days): totals, per day, per kind of API call, and their generations,
// the latest first (at most limit).
async function usageHistory (params, userId, { days, limit }) {
  return withActivity(params, async activity => {
    const filter = { userId, ...period(days) }
    const [summary, generations] = await Promise.all([
      usage(activity, filter),
      activity.find({ ...filter, kind: 'variants' })
        .project({ _id: 0, at: 1, template: 1, variants: 1, failed: 1, durationMs: 1, apiCalls: 1, rateLimited: 1, waitMs: 1, rateLimitDelayMs: 1, formats: 1, languages: 1, renders: 1, renderMs: 1 })
        .sort({ at: -1 }).limit(limit).toArray()
    ])
    return {
      scope: 'user',
      userId,
      env: environment(),
      days: days || null,
      ...summary,
      generations: generations.map(g => ({
        at: isoDate(g.at),
        template: g.template,
        variants: num(g.variants),
        failed: num(g.failed),
        durationMs: num(g.durationMs),
        apiCalls: num(g.apiCalls),
        rateLimited: num(g.rateLimited),
        waitMs: num(g.waitMs),
        rateLimitDelayMs: g.rateLimitDelayMs == null ? null : num(g.rateLimitDelayMs),
        averageRenderMs: average(g.renderMs, g.renders),
        formats: g.formats,
        languages: g.languages
      }))
    }
  })
}

// Usage of all the users over the last days (since the start without days): totals, per user, per day and per kind of API call.
async function usageReport (params, { days }) {
  return withActivity(params, async activity => {
    const filter = period(days)
    const [summary, users] = await Promise.all([
      usage(activity, filter),
      activity.aggregate([{ $match: filter }, { $group: { _id: '$userId', lastAt: { $max: '$at' }, ...SUMS } }, { $sort: { variants: -1 } }]).toArray()
    ])
    return {
      scope: 'all',
      env: environment(),
      days: days || null,
      ...summary,
      users: users.map(({ _id, lastAt, ...user }) => withAverage({ user: _id, lastActivity: isoDate(lastAt), ...user }))
    }
  })
}

// Average time of the calls of the given operations over the last days, in ms: those of the user, or of all the users for an
// operation the user has not made yet ({ [operation]: { averageMs, source: 'user' | 'all' } }, missing when never made).
async function callAverages (params, userId, operations, days = 30) {
  return withActivity(params, async activity => {
    const averages = async filter => Object.fromEntries((await activity.aggregate([
      { $match: { ...filter, ...period(days) } },
      { $unwind: '$calls' },
      { $match: { 'calls.operation': { $in: [...operations, ...Object.keys(RENAMED_OPERATIONS)] } } },
      { $group: { _id: '$calls.operation', count: { $sum: '$calls.count' }, failed: { $sum: '$calls.failed' }, totalMs: { $sum: '$calls.totalMs' } } }
    ]).toArray().then(mergeRenamed)).map(op => [op._id, average(op.totalMs, op.count - op.failed)]).filter(([, ms]) => ms))
    const [own, all] = await Promise.all([averages({ userId }), averages({})])
    return Object.fromEntries(operations.filter(op => own[op] || all[op])
      .map(op => [op, own[op] ? { averageMs: own[op], source: 'user' } : { averageMs: all[op], source: 'all' }]))
  })
}

module.exports = { recordActivity, usageHistory, usageReport, callAverages }
