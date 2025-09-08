const al_http = await import(`${process.cwd()}/node_modules/agentlang/out/utils/http.js`)
const al_module = await import(`${process.cwd()}/node_modules/agentlang/out/runtime/module.js`)
const al_integmanager = await import(`${process.cwd()}/node_modules/agentlang/out/runtime/integrations.js`)

const encodeForBasicAuth = al_http.encodeForBasicAuth
const makeInstance = al_module.makeInstance
const isInstanceOfType = al_module.isInstanceOfType

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        })
        clearTimeout(timeoutId)
        return response
    } catch (error) {
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

const Incident = 'incident'
const Task = 'sc_task'

async function addCloseNotes(sysId, comment, table = Incident) {
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/${table}/${sysId}`
    const data = { close_notes: comment }
    try {
        const response = await fetchWithTimeout(apiUrl, {
            method: 'PATCH',
            headers: await makeStandardHeaders(),
            body: JSON.stringify(data),
        });


        console.log("jsonstrnigltfy", apiUrl, JSON.stringify( {
            method: 'PATCH',
            headers: await makeStandardHeaders(),
            body: JSON.stringify(data),
        }))
        
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

async function getIncidents(sysId, count, table = Incident) {
    const instanceUrl = getInstanceUrl()
    const apiUrl = sysId ?
          `${instanceUrl}/api/now/table/${table}/${sysId}` :
          `${instanceUrl}/api/now/table/${table}?sysparm_limit=${count}&sysparm_query=active=true^sys_created_on>=javascript:gs.hoursAgoStart(${process.env.SERVICENOW_HOURS_AGO || 100000})^ORDERBYDESCsys_created_on`;
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
            const comments = (table == Incident) ? await getComments(d.sys_id) : undefined
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
        console.error('Failed to get incidents:', error)
        return { error: error.message };
    }
}

async function updateIncident(sysId, data, table = Incident) {
    /*if (data.comment) {
        return addCloseNotes(sysId, data.comment, table)
    }*/
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/${table}/${sysId}`
    data.state = table == Incident ? "6" : "3"
    data.close_code = "Resolved"
    data.close_notes = data.comment || 'Closed'
    data.closed_at = new Date().toISOString()
    data.active = false
    try {
        const response = await fetchWithTimeout(apiUrl, {
            method: 'PUT',
            headers: await makeStandardHeaders(),
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log(`Resolved ${table} ${sysId} with comments ${data.close_notes}`)
        const responseData = await response.json();
        return responseData;
    } catch (error) {
        console.error('Failed to update ${table}:', error)
        return { error: error }
    }
}

function isIncident(obj) {
    return isInstanceOfType(obj, 'servicenow/incident')
}

function getSysId(inst) {
    const s = inst.lookup('sys_id')
    return s.split('/')[0]
}

function getSysType(inst) {
    const s = inst.lookup('sys_id')
    return s.split('/')[1]
}

function asIncidentInstance(data, sys_id) {
    return makeInstance('servicenow', 'incident', new Map().set('data', data).set('sys_id', sys_id))
}

export async function updateInstance(resolver, inst, newAttrs) {
    if (isIncident(inst)) {
        const sys_id = getSysId(inst)
	const table = getSysType(inst)
        let r = await updateIncident(sys_id, newAttrs.get('data'), table)
        return asIncidentInstance(r, `${sys_id}/${table}`)
    } else {
        throw new Error(`Cannot update instance ${inst}`)
    }
}

export async function queryInstances(resolver, inst, queryAll, table = Incident) {
    if (isIncident(inst)) {
	const s = inst.lookupQueryVal('sys_id').split('/')
        const sys_id = s ? s[0] : undefined
	table = sys_id ? s[1] : table
        let r = []
        if (sys_id) {
            r = await getIncidents(sys_id, queryAll ? 100 : 1, table)
        } else if (queryAll) {
            r = await getIncidents(undefined, 100, table)
        } else {
            return []
        }
        if (!(r instanceof Array)) {
            r = [r]
        }
        return r.map((data) => { return asIncidentInstance(data, `${data.sys_id}/${table}`) })
    } else {
        return []
    }
}

async function getAndProcessIncidents(resolver, table) {
    const result = await getIncidents(undefined, 100, table)
    if (result instanceof Array) {
        for (let i = 0; i < result.length; ++i) {
            const incident = result[i]
            console.log(`processing ${table} ${incident.sys_id} ${incident.short_description}`)
	    const desc = `${incident.short_description}.${incident.comments ? incident.comments : ''}`
            const inst = asIncidentInstance(JSON.stringify({description: desc}), `${incident.sys_id}/${table}`)
            await resolver.onSubscription(inst, true)
        }
    }
}

async function handleSubs(resolver) {
    console.log('fetching incidents ...')
    await getAndProcessIncidents(resolver, Incident)
    console.log('fetching tasks ...')
    await getAndProcessIncidents(resolver, Task)
}

export async function subs(resolver) {
    await handleSubs(resolver)
    setInterval(async () => {
        await handleSubs(resolver)
    }, 60000 * 2)
}

export function assignIncident(sys_id, userEmail) {
    console.log(`Incident ${sys_id} assigned to ${userEmail}`)
}
