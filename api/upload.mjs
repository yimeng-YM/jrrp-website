import crypto from 'node:crypto'

// 与上一级 JRRP 插件使用同一个 COS 存储桶和 kayoko/kayoko_ 编号规则。
// 密钥只从 Vercel 环境变量读取，绝不发送给浏览器。
const BUCKET = 'kayoko-1343642582'
const REGION = 'ap-chongqing'
const PREFIX = 'kayoko/kayoko_'
const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const MAX_SIZE = 20 * 1024 * 1024
const START_ID = 930
let lastKnownMax = START_ID

function reply(body, status) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function validPassword(actual, expected) {
  const a = crypto.createHash('sha256').update(actual).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

async function exists(id) {
  const results = await Promise.all(EXTENSIONS.map(async (ext) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(`https://${HOST}/${PREFIX}${String(id).padStart(3, '0')}.${ext}`, {
        method: 'HEAD', cache: 'no-store', signal: controller.signal
      })
      return response.ok ? true : response.status === 404 ? false : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }))
  if (results.includes(true)) return true
  if (results.includes(null)) throw new Error('无法确认下一个图片编号')
  return false
}

async function findMax() {
  const start = lastKnownMax
  if (!(await exists(start))) {
    let low = 1
    let high = start - 1
    let found = 0
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (await exists(mid)) { found = mid; low = mid + 1 }
      else high = mid - 1
    }
    lastKnownMax = found
    return found
  }
  if (!(await exists(start + 1))) return start
  let low = start + 1
  let step = 2
  let high
  while (true) {
    const candidate = start + step
    if (candidate > 99999) throw new Error('图片编号已超出支持范围')
    if (!(await exists(candidate))) { high = candidate - 1; break }
    low = candidate
    step *= 2
  }
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (await exists(mid)) low = mid
    else high = mid - 1
  }
  lastKnownMax = low
  return low
}

export function signRequest(method, path, headers, secretId, secretKey) {
  const now = Math.floor(Date.now() / 1000)
  const keyTime = `${now};${now + 60}`
  const signedHeaders = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort(([a], [b]) => a.localeCompare(b))
  const headerList = signedHeaders.map(([key]) => key).join(';')
  const httpHeaders = signedHeaders.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  const httpString = `${method.toLowerCase()}\n${path}\n\n${httpHeaders}\n`
  const stringToSign = `sha1\n${keyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`
  const signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex')
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex')
  const query = new URLSearchParams({
    'q-sign-algorithm': 'sha1',
    'q-ak': secretId,
    'q-sign-time': keyTime,
    'q-key-time': keyTime,
    'q-header-list': headerList,
    'q-url-param-list': '',
    'q-signature': signature
  })
  return `https://${HOST}${path}?${query}`
}

export async function POST(request) {
  const password = process.env.UPLOAD_PASSWORD
  const secretId = process.env.COS_SECRET_ID
  const secretKey = process.env.COS_SECRET_KEY
  if (!password || !secretId || !secretKey) return reply({ error: '上传服务尚未配置' }, 503)
  const authorization = request.headers.get('authorization') || ''
  if (!authorization.startsWith('Bearer ') || !validPassword(authorization.slice(7), password)) {
    return reply({ error: '上传口令不正确' }, 401)
  }

  let input
  try { input = await request.json() } catch { return reply({ error: '请求格式不正确' }, 400) }
  const extension = input?.extension
  const size = input?.size
  if (!Object.hasOwn(MIME, extension) || !Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    return reply({ error: '只支持 20 MB 内的 PNG、JPEG、WebP、GIF 图片' }, 400)
  }

  try {
    const id = (await findMax()) + 1
    const path = `/${PREFIX}${String(id).padStart(3, '0')}.${extension}`
    const headersToSign = {
      'host': HOST,
      'content-length': String(size),
      'content-type': MIME[extension],
      'x-cos-forbid-overwrite': 'true'
    }
    const uploadUrl = signRequest('PUT', path, headersToSign, secretId, secretKey)
    return reply({
      id,
      extension,
      uploadUrl,
      headers: { 'Content-Type': MIME[extension], 'x-cos-forbid-overwrite': 'true' }
    }, 200)
  } catch (error) {
    console.error('[JRRP website] 无法生成上传授权:', error)
    return reply({ error: '无法确认下一个图片编号，请稍后重试' }, 502)
  }
}
