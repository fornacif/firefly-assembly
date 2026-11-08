const { Core } = require('@adobe/aio-sdk')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { WebStandardStreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
const { WORKFLOW, registerTools, registerResources, registerPrompts, runTask } = require('./tools.js')
const { validateRequestAuth } = require('./validator.js')
const { handlePickerRequest } = require('./aem-picker.js')

let logger = null

function createMcpServer (params) {
    const server = new McpServer({
        name: 'firefly-assembly',
        version: '1.1.0'
    }, {
        capabilities: {
            logging: {},
            tools: {},
            resources: {},
            prompts: {}
        },
        instructions: WORKFLOW
    })

    registerTools(server, params)
    registerResources(server, params)
    registerPrompts(server)

    return server
}

function parseRequestBody (params) {
    if (!params.__ow_body) return null

    try {
        if (typeof params.__ow_body === 'string') {
            try {
                return JSON.parse(Buffer.from(params.__ow_body, 'base64').toString('utf8'))
            } catch (e) {
                return JSON.parse(params.__ow_body)
            }
        }
        return params.__ow_body
    } catch (error) {
        throw new Error(`Failed to parse request body: ${error.message}`)
    }
}

function normalizeHeaders (headers) {
    const normalized = {}
    if (headers) {
        for (const key in headers) {
            normalized[key.toLowerCase()] = headers[key]
        }
    }
    return normalized
}

function createWebRequest (params) {
    const body = parseRequestBody(params)
    const incomingHeaders = normalizeHeaders(params.__ow_headers)
    const method = (params.__ow_method || 'POST').toUpperCase()
    const path = params.__ow_path || '/mcp-server'
    const headers = new Headers(incomingHeaders)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json, text/event-stream')
    const mcpSessionId = params['mcp-session-id'] || incomingHeaders['mcp-session-id']
    if (mcpSessionId) headers.set('mcp-session-id', mcpSessionId)
    const init = { method, headers }
    if (body != null && method === 'POST') {
        init.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    return new Request(`https://runtime.adobe.io${path}`, init)
}

async function responseToRuntime (response) {
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    return { statusCode: response.status, headers, body: await response.text() }
}

async function handleMcpRequest (params) {
    const server = createMcpServer(params)
    const body = parseRequestBody(params)

    try {
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        })
        await server.connect(transport)
        const webRequest = createWebRequest(params)
        const requestOptions = body != null ? { parsedBody: body } : {}
        const response = await transport.handleRequest(webRequest, requestOptions)
        return await responseToRuntime(response)
    } catch (error) {
        logger?.error('Error in handleMcpRequest:', error)
        try { server.close() } catch (_) {}

        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: `Internal server error: ${error.message}` },
                id: null
            })
        }
    }
}

// Public URL of this action, which MCP clients use as the OAuth resource identifier.
function getResourceUrl (params) {
    if (params.MCP_RESOURCE_URL) return String(params.MCP_RESOURCE_URL).replace(/\/$/, '')
    const [namespace, ...actionPath] = (process.env.__OW_ACTION_NAME || '').split('/').filter(Boolean)
    return `https://${namespace}.adobeioruntime.net/api/v1/web/${actionPath.join('/')}`
}

// RFC 9728 metadata pointing MCP clients (e.g. Claude) to Adobe IMS for sign-in.
function getProtectedResourceMetadata (params) {
    return {
        resource: getResourceUrl(params),
        authorization_servers: [(params.IMS_HOST && String(params.IMS_HOST).trim()) || 'https://ims-na1.adobelogin.com'],
        scopes_supported: String(params.IMS_SCOPES || 'openid,AdobeID,email').split(/[\s,]+/).filter(Boolean),
        bearer_methods_supported: ['header']
    }
}

async function main (params) {
    try {
        try {
            logger = Core.Logger('firefly-assembly', { level: params.LOG_LEVEL || 'info' })
        } catch (loggerError) {
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: `Logger creation error: ${loggerError.message}` })
            }
        }

        // Task started by a tool (tools.js, startTask): an invocation of this action, not a web request
        if (params.__task && !params.__ow_method) return await runTask(params)

        const incomingHeaders = normalizeHeaders(params.__ow_headers)
        const requestPath = params.__ow_path || ''

        switch (params.__ow_method?.toLowerCase()) {
        case 'get':
            if (requestPath.includes('.well-known/oauth-protected-resource')) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(getProtectedResourceMetadata(params))
                }
            }

            if (requestPath.includes('.well-known/oauth') || requestPath.includes('/oauth/') || requestPath.includes('/authorize') || requestPath.includes('/token')) {
                return {
                    statusCode: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: 'not_found',
                        error_description: 'Authorization is handled by Adobe IMS. See /.well-known/oauth-protected-resource.'
                    })
                }
            }

            if (incomingHeaders.accept && incomingHeaders.accept.includes('text/event-stream')) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' },
                    body: 'event: error\ndata: {"error": "SSE not supported in serverless. Use HTTP transport."}\n\n'
                }
            }

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'healthy',
                    server: 'firefly-assembly',
                    version: '1.1.0',
                    timestamp: new Date().toISOString()
                })
            }

        case 'options':
            return { statusCode: 204, headers: {}, body: '' }

        case 'post': {
            // AEM picker page (aem-picker.html): authenticated by its session id, not by an IMS token
            if (requestPath.replace(/\/$/, '').endsWith('/aem-picker')) {
                return await handlePickerRequest(parseRequestBody(params))
            }

            const authResult = await validateRequestAuth(params, logger)
            if (authResult.error) {
                return {
                    statusCode: 401,
                    headers: {
                        'Content-Type': 'application/json',
                        'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${getResourceUrl(params)}/.well-known/oauth-protected-resource"`
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32001, message: authResult.error },
                        id: null
                    })
                }
            }
            return await handleMcpRequest(params)
        }

        default:
            return {
                statusCode: 405,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: `Method '${params.__ow_method}' not allowed. Supported: GET, POST, OPTIONS` },
                    id: null
                })
            }
        }
    } catch (error) {
        logger?.error('Uncaught error:', error)
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: `Unhandled server error: ${error.message}` },
                id: null
            })
        }
    }
}

module.exports = { main }
