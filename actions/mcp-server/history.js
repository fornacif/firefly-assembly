// History of the activity of the users (template readings, crops, image generations, generations of variants), kept in the
// database of the workspace (App Builder Database Storage, region emea): one document per task, with the API calls it made.
// Kept without limit of time. Read by get-usage-history (the user's own generations) and get-usage-report (all the users, for the admins).
const crypto = require('crypto')
const libDb = require('@adobe/aio-lib-db')
const { generateAccessToken } = require('@adobe/aio-lib-core-auth')
const stateStore = require('./state')

// Region of the database, as provisioned (app.config.yaml)
const DB_REGION = 'emea'
const COLLECTION = 'activity'
// Email of a user, from the IMS profile, kept this long in state
const PROFILE_TTL_SECONDS = 30 * 24 * 3600
const IMS_PROFILE_URL = 'https://ims-na1.adobelogin.com/ims/profile/v1'

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

const profileKey = userId => `profile-${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)}`

// Email of the user of an IMS token, from its profile (kept in state); null when the profile does not give it.
async function userEmail (userId, token) {
  if (!userId || !token) return null
  const stored = (await stateStore.get(profileKey(userId)).catch(() => undefined))?.value
  if (stored) return stored.email
  const response = await fetch(IMS_PROFILE_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  const email = (await response.json()).email || null
  await stateStore.put(profileKey(userId), { email }, { ttl: PROFILE_TTL_SECONDS }).catch(() => {})
  return email
}

// API calls of a task by kind: [{ api, operation, count, failed, totalMs, requests }]
function callsByKind (calls) {
  const kinds = new Map()
  calls.forEach(call => {
    const kind = kinds.get(call.operation) || { api: call.api, operation: call.operation, count: 0, failed: 0, totalMs: 0, requests: 0 }
    kind.count++
    if (call.ok) kind.totalMs += call.ms; else kind.failed++
    kind.requests += call.requests || 0
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
    email: task.email || null,
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

// Generations of a user over the last days (all of them without days), the latest first (at most limit), and their totals.
async function usageHistory (params, userId, { days, limit }) {
  return withActivity(params, async activity => {
    const filter = { userId, ...period(days) }
    const [generations, totals] = await Promise.all([
      activity.find({ ...filter, kind: 'variants' })
        .project({ _id: 0, at: 1, template: 1, variants: 1, failed: 1, durationMs: 1, apiCalls: 1, formats: 1, languages: 1, renders: 1, renderMs: 1 })
        .sort({ at: -1 }).limit(limit).toArray(),
      activity.aggregate([{ $match: filter }, {
        $group: { _id: null, generations: { $sum: '$generations' }, variants: { $sum: '$variants' }, failed: { $sum: '$failed' }, apiCalls: { $sum: '$apiCalls' }, renders: { $sum: '$renders' }, renderMs: { $sum: '$renderMs' } }
      }]).toArray()
    ])
    const total = totals[0] || {}
    return {
      days: days || null,
      totals: { generations: num(total.generations), variants: num(total.variants), failed: num(total.failed), apiCalls: num(total.apiCalls), averageRenderMs: average(total.renderMs, total.renders) },
      generations: generations.map(g => ({
        at: isoDate(g.at),
        template: g.template,
        variants: num(g.variants),
        failed: num(g.failed),
        durationMs: num(g.durationMs),
        apiCalls: num(g.apiCalls),
        averageRenderMs: average(g.renderMs, g.renders),
        formats: g.formats,
        languages: g.languages
      }))
    }
  })
}

const SUMS = { generations: { $sum: '$generations' }, variants: { $sum: '$variants' }, failed: { $sum: '$failed' }, apiCalls: { $sum: '$apiCalls' }, requests: { $sum: '$requests' }, renders: { $sum: '$renders' }, renderMs: { $sum: '$renderMs' } }
const numbers = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'string' ? value : num(value)]))
const withAverage = ({ renders, renderMs, ...rest }) => ({ ...numbers(rest), averageRenderMs: average(renderMs, renders) })

// Usage of all the users over the last days (since the start without days): totals, per user, per day and per kind of API call.
async function usageReport (params, { days }) {
  return withActivity(params, async activity => {
    const match = { $match: period(days) }
    const [users, perDay, operations] = await Promise.all([
      activity.aggregate([match, { $group: { _id: '$userId', email: { $max: '$email' }, lastAt: { $max: '$at' }, ...SUMS } }, { $sort: { variants: -1 } }]).toArray(),
      activity.aggregate([match, { $group: { _id: '$day', users: { $addToSet: '$userId' }, ...SUMS } }, { $sort: { _id: 1 } }]).toArray(),
      activity.aggregate([match, { $unwind: '$calls' }, {
        $group: { _id: '$calls.operation', api: { $first: '$calls.api' }, count: { $sum: '$calls.count' }, failed: { $sum: '$calls.failed' }, totalMs: { $sum: '$calls.totalMs' }, requests: { $sum: '$calls.requests' } }
      }, { $sort: { count: -1 } }]).toArray()
    ])
    const sum = key => users.reduce((total, user) => total + num(user[key]), 0)
    return {
      days: days || null,
      totals: withAverage({ users: users.length, ...Object.fromEntries(Object.keys(SUMS).map(key => [key, sum(key)])) }),
      users: users.map(({ _id, email, lastAt, ...user }) => withAverage({ user: email || _id, lastActivity: isoDate(lastAt), ...user })),
      perDay: perDay.map(({ _id, users, ...day }) => withAverage({ day: _id, users: users.length, ...day })),
      apiCalls: operations.map(({ _id, totalMs, ...op }) => ({ operation: _id, ...numbers(op), averageMs: average(totalMs, num(op.count) - num(op.failed)) }))
    }
  })
}

module.exports = { recordActivity, userEmail, usageHistory, usageReport }
