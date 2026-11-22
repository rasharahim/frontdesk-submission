import {spawn} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {setTimeout as wait} from 'node:timers/promises'
import bcrypt from 'bcrypt'
import {createApp} from '../../server/dist/app.js'
import {createDatabase} from '../../server/dist/lib/db.js'
import {isLocalDatabase} from '../../server/dist/config/env.js'

process.chdir(fileURLToPath(new URL('../../', import.meta.url)))
await mkdir('.tmp/phase7', { recursive: true })
process.loadEnvFile('.env.test')
process.loadEnvFile('.env.migrate')
const ru=process.env.TEST_DATABASE_URL, ou=process.env.TEST_MIGRATION_DATABASE_URL
if(!ru||!ou||!isLocalDatabase(ru,'frontdesk_test','runtime')||!isLocalDatabase(ou,'frontdesk_test','owner')) throw Error('Isolated database required')
const db=createDatabase(ru), owner=createDatabase(ou)
const password=randomUUID(), marker='Staff canary '+randomUUID()
const subject='Browser verification '+randomUUID().slice(0,8)
const serverApp=createApp({checkDatabase:()=>db.$queryRaw`SELECT 1`, staticDir:resolve('client/dist'), api:{db,settings:{
 cookieName:'browser_session',ttlHours:8,secure:false,origins:['http://127.0.0.1:3077']}}})
const server=serverApp.listen(3077,'127.0.0.1')
const profile=resolve('.tmp/phase7/chrome-'+randomUUID())
const chrome=spawn(process.env.FRONTDESK_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run',
 '--remote-debugging-port=0','--user-data-dir='+profile],{stdio:'ignore',windowsHide:true})
chrome.on('error', () => {})
let ws
const out=(step)=>console.log(step)
function assert(value, msg) { if(!value) throw Error(msg) }
async function until(predicate, msg) {
 for(let i=0;i<100;i++){
   const result=await predicate()
   if(result)return result
   await wait(100)
 }
 throw Error(msg)
}
let commandId=0
const pending=new Map()
function command(method, params={}, sessionId){
 const id=++commandId
 return new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject})
  ws.send(JSON.stringify({id,method,params,sessionId}))
 })
}
async function tab(width=1440){
 const {browserContextId}=await command('Target.createBrowserContext')
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId})
 const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true})
 const send=(name,args)=>command(name,args,sessionId)
 const evaluate=async (fn,...args)=>{
  const expression='('+fn.toString()+')(...'+JSON.stringify(args)+')'
  const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
  if(result.exceptionDetails) throw Error('Browser evaluation error')
  return result.result.value
 }
 const size=(width)=>send('Emulation.setDeviceMetricsOverride',{width,height:width<821?860:1000,deviceScaleFactor:1,mobile:false})
 await size(width)
 const goto=(path)=>send('Page.navigate',{url:'http://127.0.0.1:3077'+path})
 const see=(label)=>until(()=>evaluate((label)=>document.body?.innerText.includes(label),label),'Missing: '+label)
 const click=async(label)=>{
   const selector=await evaluate((label)=>{
    const element=[...document.querySelectorAll('a,button')].find(el=>(el.innerText.trim()===label||el.getAttribute('aria-label')===label)&&!el.disabled)
    if(!element)return false
    element.click()
    return true
   },label)
   assert(selector,'Missing control: '+label)
 }
 const fill=async(selector,value)=>{
   const ok=await evaluate((sel,value)=>{
    const element=document.querySelector(sel)
    if(!element)return false
    const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value').set
    setter.call(element,value)
    element.dispatchEvent(new Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}))
    return true
   },selector,value)
   assert(ok,'Missing field: '+selector)
 }
 const shot=async(filename)=>{
   const {data}=await send('Page.captureScreenshot',{format:'png'})
   await writeFile('.tmp/phase7/'+filename+'.png',Buffer.from(data,'base64'))
 }
 const fit=async()=>{
  assert(await evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Unexpected horizontal page overflow')
 }
 return {evaluate,send,goto,see,click,fill,shot,fit,size}
}
async function login(page,user, bad=false){
 await page.see('Sign in to Frontdesk')
 await page.fill('input[name=email]',user.email)
 await page.fill('input[name=password]',bad?'invalid-password':password)
 await page.click('Sign in')
 if(bad) await page.see('Email or password is incorrect.')
 else await page.see(user.role==='AGENT'?'Ticket queue':'My tickets')
}

try {
 const identities=[]
 const hash=await bcrypt.hash(password,4)
 for(const [displayName,role] of [['Taylor Test','CUSTOMER'],['Morgan Test','AGENT'],['Casey Test','AGENT']]){
   identities.push(await owner.user.create({data:{email:randomUUID()+'@example.test',role,displayName,passwordHash:hash},
      select:{email:true,role:true,id:true}}))
 }
 const port=await until(async()=> (await readFile(resolve(profile,'DevToolsActivePort'),'utf8').catch(()=>''))?.split(/\r?\n/).filter(Boolean)[0],' waiting for Chrome')
 const actualPort=port
 assert(actualPort, 'Chrome debugging port unavailable')
 const version=await fetch('http://127.0.0.1:'+actualPort+'/json/version').then(r=>r.json())
 ws=new WebSocket(version.webSocketDebuggerUrl)
 await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})})
 ws.addEventListener('message',({data})=>{
   const {id,result,error}=JSON.parse(data)
   const callbacks=pending.get(id)
   if(callbacks){pending.delete(id);if(error)callbacks.reject(Error(error.message));else callbacks.resolve(result)}
 })
 const [customer,agent,other]=await Promise.all([tab(),tab(),tab()])
 await Promise.all([customer.goto('/login'),agent.goto('/login'),other.goto('/login')])
 await customer.see('Sign in to Frontdesk')
 await customer.shot('login-desktop')
 await customer.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
 await customer.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
 assert(await customer.evaluate(()=>document.activeElement?.matches('input[name=email]')),'Login keyboard focus did not reach email')
 await login(customer,identities[0],true)
 await login(customer,identities[0])
 await customer.see('No tickets found')
 await customer.shot('customer-dashboard-empty-desktop')
 await customer.click('New ticket')
 await customer.see('New support ticket')
 await customer.shot('customer-new-desktop')
 await customer.fill('input[name=subject]',subject)
 await customer.fill('textarea[name=body]','Synthetic browser fixture\n<img data-probe src=x onerror=alert(1)>')
 await customer.click('Create ticket')
 await customer.see(subject)
 assert(await customer.evaluate(()=>!document.querySelector('img[data-probe]')),'Unsafe message rendering')
 const customerPath=await customer.evaluate(()=>location.pathname)
 await customer.shot('customer-ticket-desktop')
 await customer.fill('textarea','A public reply from the customer')
 await customer.send('Network.enable')
 await customer.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0})
 await customer.click('Send reply')
 await customer.see('Could not connect to Frontdesk.')
 assert(await customer.evaluate(()=>document.querySelector('textarea').value==='A public reply from the customer'),'Failed send discarded the draft')
 await customer.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1})
 await customer.click('Send reply')
 await customer.see('A public reply from the customer')
 await customer.click('Back to tickets')
 await customer.see(subject)
 await customer.shot('customer-dashboard-desktop')
 await Promise.all([login(agent,identities[1]),login(other,identities[2])])
 await agent.click('Unassigned')
 await agent.see('Unassigned tickets')
 await agent.shot('agent-queue-desktop')
 await agent.fill('.search input',subject)
 await until(()=>agent.evaluate((title)=>new URLSearchParams(location.search).get('q')===title,subject),'Debounced search did not reach the URL')
 const agentPath=customerPath.replace('/customer/','/agent/')
 await until(()=>agent.evaluate((path)=>document.querySelector('a[href="'+path+'"]')?.textContent,agentPath),'Fresh unassigned ticket missing from search')
 await agent.evaluate((path)=>document.querySelector('a[href="'+path+'"]').click(),agentPath)
 await agent.see('Claim ticket')
 await agent.click('Back to tickets')
 await until(()=>agent.evaluate((subject)=>new URLSearchParams(location.search).get('q')===subject,subject),'Queue search lost on return')
 await agent.evaluate(()=>history.back())
 await agent.see('Claim ticket')
 await agent.evaluate(()=>history.forward())
 await agent.see('Unassigned tickets')
 await Promise.all([agent.goto(agentPath),other.goto(agentPath)])
 await Promise.all([agent.see('Claim ticket'),other.see('Claim ticket')])
 await agent.click('Claim ticket')
 await agent.see('Ticket assigned to you.')
 await other.click('Claim ticket')
 await other.see('This ticket has already been claimed.')
 await other.see('Morgan Test')
 out('Two authenticated browser agents: winning claim and visible conflict with refreshed assignee')
 await agent.see('Service levels')
 await agent.fill('textarea','A public reply from the support agent')
 await agent.click('Send reply')
 await agent.see('Public reply sent.')
 await agent.click('Internal note')
 await agent.fill('textarea',marker)
 await agent.click('Add internal note')
 await agent.see(marker)
 await agent.shot('agent-workspace-desktop')
 await agent.click('Audit history')
 await agent.see('Internal note added')
 await agent.shot('agent-audit-desktop')
 await agent.click('Conversation')
 for(let i=0;i<17;i++){
   const note='Synthetic audit pagination note '+(i+1)
   await agent.fill('textarea',note)
   await agent.click('Add internal note')
   await agent.see(note)
 }
 await agent.click('Audit history')
 await agent.see('Load more activity')
 await agent.click('Load more activity')
 await until(()=>agent.evaluate(()=>document.querySelectorAll('.history li').length===22),'Audit cursor did not append the last two events')
 await agent.click('Conversation')
 await agent.click('Request information')
 await agent.fill('textarea','Could you send the steps to reproduce?')
 await agent.click('Send question and wait')
 await agent.see('Paused')
 await customer.goto(customerPath)
 await customer.see('Could you send the steps to reproduce?')
 await customer.see('A public reply from the support agent')
 assert(await customer.evaluate(()=>performance.getEntriesByType('resource').every(({name})=>!name.includes('/audit?'))),'Customer made a staff audit request')
 assert(await customer.evaluate((m)=>!document.body.innerText.includes(m)&&!document.body.innerText.includes('Audit history'),marker),'Customer private content')
 await customer.fill('textarea','Steps supplied by the customer.')
 await customer.click('Send reply')
 await customer.see('Steps supplied by the customer.')
 await agent.click('Refresh')
 await agent.see('Resolve ticket')
 await agent.click('Change priority')
 await agent.fill('select[name=priority]','URGENT')
 await agent.fill('textarea','The workflow is blocked.')
 await agent.click('Update priority')
 await agent.see('Priority updated.')
 await agent.click('Resolve ticket')
 await agent.click('Confirm resolution')
 await agent.see('Ticket resolved.')
 await customer.goto(customerPath)
 await customer.see('Reopen ticket')
 await customer.fill('textarea','The issue still affects another export.')
 await customer.click('Reopen ticket')
 await customer.see('Ticket reopened.')
 await agent.click('Refresh')
 await agent.see('Resolution · Cycle 2')
 out('Real ticket creation, public and private messages, wait, customer resume, priority, resolution, reopen and SLA cycle passed')
 for(const width of [1440,1024,768,390,360]){
   await Promise.all([agent.size(width),customer.size(width)])
   await Promise.all([agent.fit(),customer.fit()])
   if(width===390){await agent.shot('agent-workspace-mobile');await customer.shot('customer-ticket-mobile')}
 }
 await agent.goto('/agent/tickets')
 await agent.see('Ticket queue')
 await agent.fill('.search input',subject)
 await agent.see(subject)
 for(const width of [1024,768,390,360]){
  await agent.size(width)
  await agent.fit()
  if(width===390)await agent.shot('agent-queue-mobile')
 }
 await customer.goto('/customer/tickets/new')
 await customer.see('New support ticket')
 await customer.fit()
 await customer.shot('customer-new-mobile')
 out('Layout checks at 1440, 1024, 768, 390 and 360 pixels')
 out('Keyboard focus, network error draft recovery, audit cursor pagination and customer request isolation passed')
 await customer.goto(agentPath)
 await customer.see('Page not available')
 await customer.click('Sign out')
 await customer.see('Sign in to Frontdesk')
 await login(customer,identities[0])
 await customer.goto(customerPath)
 await customer.see(subject)
 await customer.send('Network.clearBrowserCookies')
 await customer.click('Refresh')
 await customer.see('Your session ended.')
 assert(await customer.evaluate((title)=>!document.body.innerText.includes(title),subject),'Protected state visible')
 const response=await fetch('http://127.0.0.1:3077'+agentPath,{headers:{Accept:'text/html'}})
 assert(response.ok,'Nested production route unavailable')
 const [health,ready,missingApi,missingAsset]=await Promise.all(['/api/health','/api/ready','/api/missing','/assets/nonexistent.js'].map(async p=>(await fetch('http://127.0.0.1:3077'+p)).status))
 assert([health,ready,missingApi,missingAsset].join()==='200,200,404,404','Production response behavior')
 out('Invalid login, empty state, logout, expired session, role routing, production nested refresh and asset/API isolation passed')
} finally {
 if(ws?.readyState===1){await command('Browser.close').catch(()=>{});ws.close()} else chrome.kill()
 server.close()
 await Promise.all([db.$disconnect(),owner.$disconnect()])
}
