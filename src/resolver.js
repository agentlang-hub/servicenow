const al_http = await import(`${process.cwd()}/node_modules/agentlang/out/utils/http.js`)
const al_module = await import(`${process.cwd()}/node_modules/agentlang/out/runtime/module.js`)
const al_integmanager = await import(`${process.cwd()}/node_modules/agentlang/out/runtime/integrations.js`)

const encodeForBasicAuth = al_http.encodeForBasicAuth
const makeInstance = al_module.makeInstance
const isInstanceOfType = al_module.isInstanceOfType

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    console.log(`SERVICENOW RESOLVER: fetching ${url} with options ${JSON.stringify(options)}`)
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        })
        console.log(`SERVICENOW RESOLVER: response: ${JSON.stringify(response)}`)
        clearTimeout(timeoutId)
        return response
    } catch (error) {
        console.log(`SERVICENOW RESOLVER: error fetching ${url} with options ${JSON.stringify(options)}: ${error}`)
        clearTimeout(timeoutId)
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`)
        }
        throw error
    }
}

function getConfig(k) {
    try {
        return al_integmanager.getIntegrationConfig('servicenow', k)
    } catch (e) {
        console.error(`Failed to retrieve ServiceNow configuration for key '${k}':`, e.message);
        return undefined;
    }
}

function getSelectedSysIds(tableType) {
    const config = TABLE_CONFIG[tableType]
    if (!config) {
        return null
    }
    const envValue = process.env[config.envVar]
    if (!envValue) {
        return null
    }
    return envValue.split(',').map(id => id.trim()).filter(id => id.length > 0)
}

let instUrl = undefined

function getInstanceUrl() {
    if (instUrl == undefined) {
        instUrl = getConfig('url') || process.env.SERVICENOW_INSTANCE_URL
    }
    return instUrl
}

let accessToken = undefined
let tokenExpiry = undefined

function isOAuthConfigured() {
    const clientId = getConfig('client_id') || process.env.SERVICENOW_CLIENT_ID
    const clientSecret = getConfig('client_secret') || process.env.SERVICENOW_CLIENT_SECRET
    const refreshToken = getConfig('refresh_token') || process.env.SERVICENOW_REFRESH_TOKEN
    return !!(clientId && clientSecret && refreshToken)
}

async function getAccessToken() {
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
        return accessToken
    }

    const clientId = getConfig('client_id') || process.env.SERVICENOW_CLIENT_ID
    const clientSecret = getConfig('client_secret') || process.env.SERVICENOW_CLIENT_SECRET
    const refreshToken = getConfig('refresh_token') || process.env.SERVICENOW_REFRESH_TOKEN
    const instanceUrl = getInstanceUrl()

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Missing OAuth 2.0 configuration: client_id, client_secret, or refresh_token')
    }

    try {
        const tokenUrl = `${instanceUrl}/oauth_token.do`
        const response = await fetchWithTimeout(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken
            })
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Token refresh failed: ${response.status} ${errorText}`)
        }

        const tokenData = await response.json()
        
        if (!tokenData.access_token) {
            throw new Error('No access token received from ServiceNow')
        }

        accessToken = tokenData.access_token
        tokenExpiry = Date.now() + ((tokenData.expires_in || 3600) - 60) * 1000

        console.log('Successfully refreshed OAuth 2.0 token')
        return accessToken
    } catch (error) {
        console.error('Failed to refresh OAuth 2.0 token:', error)
        throw error
    }
}

async function makeStandardHeaders() {
    const username = getConfig('username') || process.env.SERVICENOW_USERNAME
    const password = getConfig('password') || process.env.SERVICENOW_PASSWORD
    
    if (username && password) {
        return {
            'Authorization': `Basic ${encodeForBasicAuth(username, password)}`,
            'Content-Type': 'application/json'
        }
    } else {
        if (!isOAuthConfigured()) {
            throw new Error('No authentication method configured. Please provide either username/password or OAuth 2.0 credentials (client_id, client_secret, refresh_token)')
        }
        
        try {
            const token = await getAccessToken()
            return {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        } catch (error) {
            console.error('Failed to create headers:', error)
            throw error
        }
    }
}

async function getComments(sysId) {
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/sys_journal_field?sysparm_display_value=true&sysparm_query=element=comments^element_id=${sysId}`
    try {
        const response = await fetchWithTimeout(apiUrl, {
            method: 'GET',
            headers: await makeStandardHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.text} ${response.statusText}`);
        }

        const data = await response.json();
        return data.result
    } catch (error) {
        console.error('Failed to get comments:', error)
        return []
    }
}

// Table configuration mapping
const TABLE_CONFIG = {
    'incident': {
        tableName: 'incident',
        entityType: 'servicenow/incident',
        hasComments: true,
        envVar: 'SELECT_INCIDENTS'
    },
    'task': {
        tableName: 'sc_task', 
        entityType: 'servicenow/task',
        hasComments: false,
        envVar: 'SELECT_TASKS'
    }
}

const Incident = 'incident'
const Task = 'task'

async function addCloseNotes(sysId, comment, tableType = Incident) {
    const config = TABLE_CONFIG[tableType]
    if (!config) {
        throw new Error(`Unknown table type: ${tableType}`)
    }
    
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/${config.tableName}/${sysId}`
    const data = { close_notes: comment }
    try {
        const response = await fetchWithTimeout(apiUrl, {
            method: 'PATCH',
            headers: await makeStandardHeaders(),
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log("addCloseNotes:", sysId, comment)

        const responseData = await response.json();
        return responseData;
    } catch (error) {
        console.error('Failed to add close notes:', error)
        return { error: error }
    }
}

async function getRecords(sysId, count, tableType = Task) {
    const config = TABLE_CONFIG[tableType]
    if (!config) {
        throw new Error(`Unknown table type: ${tableType}`)
    }
    
    const instanceUrl = getInstanceUrl()
    const selectedSysIds = getSelectedSysIds(tableType)
    
    let apiUrl
    if (sysId) {
        apiUrl = `${instanceUrl}/api/now/table/${config.tableName}/${sysId}`
    } else if (selectedSysIds && selectedSysIds.length > 0) {
        // Build query for specific sys_ids
        const sysIdQuery = selectedSysIds.map(id => `sys_id=${id}`).join('^OR^')
        apiUrl = `${instanceUrl}/api/now/table/${config.tableName}?sysparm_limit=${count}&sysparm_query=${sysIdQuery}`
    } else {
        apiUrl = `${instanceUrl}/api/now/table/${config.tableName}?sysparm_limit=${count}&sysparm_query=active=true^sys_created_on>=javascript:gs.hoursAgoStart(${process.env.SERVICENOW_HOURS_AGO || 100000})^ORDERBYDESCsys_created_on`
    }
    let statusFilter = '^stateIN1'
    if (apiUrl.includes('sysparm_query=')) {
        apiUrl = apiUrl.replace('sysparm_query=', `sysparm_query=${statusFilter.substring(1)}^`)
    } else {
        apiUrl = apiUrl + `?sysparm_query=${statusFilter.substring(1)}`
    }
    try {
        const response = await fetchWithTimeout(apiUrl, {
            method: 'GET',
            headers: await makeStandardHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.text} ${response.statusText}`);
        }

        const result = await response.json();
        const r = result.result
	    const data = (r instanceof Array) ? r : [r]
        const final_result = new Array()
        for (let i = 0; i < data.length; ++i) {
            const d = data[i]
            const comments = config.hasComments ? await getComments(d.sys_id) : undefined
            let cs = ''
	    if (comments) {
		comments.forEach(element => {
                    if (element.value.length > 15) {
			cs = `${cs}\n${element.value}`
                    }
		});
	    } else {
		cs = d.description
	    }
            final_result.push({
                short_description: d.short_description,
                comments: cs,
                active: d.active,
                number: d.number,
                opened_at: d.opened_at,
                sys_class_name: d.sys_class_name,
                sys_created_by: d.sys_created_by,
                sys_created_on: d.sys_created_on,
                sys_id: d.sys_id
            })
        }
        return final_result
    } catch (error) {
        console.error(`Failed to get ${tableType} records:`, error)
        return { error: error.message };
    }
}

async function updateRecord(sysId, data, tableType = Incident) {
    const config = TABLE_CONFIG[tableType]
    if (!config) {
        throw new Error(`Unknown table type: ${tableType}`)
    }
    
    /*if (data.comment) {
        return addCloseNotes(sysId, data.comment, tableType)
    }*/
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/${config.tableName}/${sysId}`
    try {
        const response = await fetchWithTimeout(apiUrl, {
            method: 'PATCH',
            headers: await makeStandardHeaders(),
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log(`Resolved ${tableType} ${sysId} with comments ${data.close_notes}`)
        const responseData = await response.json();
        return responseData;
    } catch (error) {
        console.error(`Failed to update ${tableType}:`, error)
        return { error: error }
    }
}

function isIncident(obj) {
    return isInstanceOfType(obj, 'servicenow/incident')
}

function isTask(obj) {
    return isInstanceOfType(obj, 'servicenow/task')
}

function getEntityType(inst) {
    if (isIncident(inst)) return 'incident'
    if (isTask(inst)) return 'task'
    return null
}

function getSysId(inst) {
    const s = inst.lookup('sys_id')
    return s.split('/')[0]
}

function getSysType(inst) {
    const s = inst.lookup('sys_id')
    return s.split('/')[1]
}

function asInstance(data, sys_id, entityType) {
    const config = TABLE_CONFIG[entityType]
    if (!config) {
        throw new Error(`Unknown entity type: ${entityType}`)
    }
    return makeInstance('servicenow', entityType, new Map().set('data', data).set('sys_id', sys_id))
}

export async function updateInstance(resolver, inst, newAttrs) {
    const entityType = getEntityType(inst)
    
    if (entityType) {
        const sys_id = getSysId(inst)
        const table = getSysType(inst)
        let r = await updateRecord(sys_id, newAttrs.get('data'), entityType)
        return asInstance(r, `${sys_id}/${table}`, entityType)
    } else {
        throw new Error(`Cannot update instance ${inst}`)
    }
}

const MAX_RESULTS=100

export async function queryInstances(resolver, inst, queryAll, tableType = Incident) {
    const entityType = getEntityType(inst)
    if (entityType) {
        const s = inst.lookupQueryVal('sys_id').split('/')
        const sys_id = s ? s[0] : undefined
        let r = []
        if (sys_id) {
            r = await getRecords(sys_id, queryAll ? MAX_RESULTS : 1, tableType)
        } else if (queryAll) {
            r = await getRecords(undefined, MAX_RESULTS, tableType)
        } else {
            return []
        }
        if (!(r instanceof Array)) {
            r = [r]
        }
        return r.map((data) => { return asInstance(data, `${data.sys_id}/${tableType}`, entityType) })
    } else {
        return []
    }
}

export async function queryInstancesIncidents(resolver, inst, queryAll) {
    return queryInstances(resolver, inst, queryAll, 'incident')
}

export async function queryInstancesTasks(resolver, inst, queryAll) {
    return queryInstances(resolver, inst, queryAll, 'task')
}

async function getAndProcessRecords(resolver, tableType) {
    const result = await getRecords(undefined, MAX_RESULTS, tableType)
    if (result instanceof Array) {
        for (let i = 0; i < result.length; ++i) {
            const record = result[i]
            console.log(`processing ${tableType} ${record.sys_id} ${record.short_description}`)
            const desc = `${record.short_description}.${record.comments ? record.comments : ''}`
            const inst = asInstance(JSON.stringify({description: desc}), `${record.sys_id}/${tableType}`, tableType)
            await resolver.onSubscription(inst, true)
        }
    }
}

async function handleSubsIncidents(resolver) {
    const selectedIncidents = getSelectedSysIds('incident')

    if (selectedIncidents) {
        console.log(`fetching selected incidents: ${selectedIncidents.join(', ')}`)
    } else {
        console.log('fetching incidents ...')
    }
    await getAndProcessRecords(resolver, 'incident')
}

async function handleSubsTasks(resolver) {
    const selectedTasks = getSelectedSysIds('task')

    if (selectedTasks) {
        console.log(`fetching selected tasks: ${selectedTasks.join(', ')}`)
    } else {
        console.log('fetching tasks ...')
    }
    await getAndProcessRecords(resolver, 'task')
}

export async function subsIncidents(resolver) {
    await handleSubsIncidents(resolver)
    const intervalMinutes = parseInt(process.env.SERVICENOW_POLL_INTERVAL_MINUTES) || 10
    const intervalMs = intervalMinutes * 60 * 1000
    console.log(`Setting ServiceNow polling interval to ${intervalMinutes} minutes`)
    setInterval(async () => {
        await handleSubsIncidents(resolver)
    }, intervalMs)
}

export async function subsTasks(resolver) {
    await handleSubsTasks(resolver)
    const intervalMinutes = parseInt(process.env.SERVICENOW_POLL_INTERVAL_MINUTES) || 10
    const intervalMs = intervalMinutes * 60 * 1000
    console.log(`Setting ServiceNow polling interval to ${intervalMinutes} minutes`)
    setInterval(async () => {
        await handleSubsTasks(resolver)
    }, intervalMs)
}

export function assignIncident(sys_id, userEmail) {
    console.log(`Incident ${sys_id} assigned to ${userEmail}`)
}

export function assignTask(sys_id, userEmail) {
    console.log(`Task ${sys_id} assigned to ${userEmail}`)
}

export async function getManagerUser() {
    const managerUsername = process.env.SERVICENOW_MANAGER_USERNAME || process.env.MANAGER_USERNAME
    if (!managerUsername) {
        console.error('Manager username not found in environment variables')
        return null
    }
    
    console.log(`Getting manager user: ${managerUsername}`)
    
    try {
        const instanceUrl = getInstanceUrl()
        const apiUrl = `${instanceUrl}/api/now/table/sys_user?sysparm_query=user_name=${managerUsername}`
        
        const response = await fetchWithTimeout(apiUrl, {
            method: 'GET',
            headers: await makeStandardHeaders()
        })

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`)
        }

        const result = await response.json()
        const users = result.result
        
        if (users && users.length > 0) {
            const user = users[0]
            console.log(`Found manager user: ${user.user_name} (${user.sys_id})`)
            return {
                id: user.sys_id,
            }
        } else {
            console.error(`Manager user not found: ${managerUsername}`)
            return null
        }
    } catch (error) {
        console.error('Failed to fetch manager user:', error)
        return null
    }
}
