// App Builder state (Adobe State service, aio-lib-state 5: the CosmosDB store of the older versions is not available on
// new namespaces). The service stores strings: values are kept as JSON. get returns { value } or undefined, as before.
const stateLib = require('@adobe/aio-lib-state')

let client = null

const init = () => (client = client || stateLib.init().catch(error => { client = null; throw error }))

async function get (key) {
  const stored = await (await init()).get(key)
  return stored ? { value: JSON.parse(stored.value) } : undefined
}

async function put (key, value, options) {
  return (await init()).put(key, JSON.stringify(value), options)
}

async function remove (key) {
  return (await init()).delete(key)
}

module.exports = { get, put, delete: remove }
