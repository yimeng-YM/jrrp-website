import crypto from 'node:crypto'

// 与上一级 JRRP 插件使用同一个 COS 存储桶和 kayoko/kayoko_ 编号规则。
// 密钥只从 Vercel 环境变量读取，绝不发送给浏览器。
const BUCKET = 'kayoko-1343642582'
const REGION = 'ap-chongqing'
const PREFIX = 'kayoko/kayoko_'
const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const MAX_SIZE = 20 * 1024 * 1024

function reply(body, status) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function validPassword(actual, expected) {
  const a = crypto.createHash('sha256').update(actual).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function xmlValue(block, tag) {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]
}

async function listImages(secretId, secretKey) {
  const images = []
  let marker = ''
  do {
    const parameters = { prefix: PREFIX, 'max-keys': '1000' }
    if (marker) parameters.marker = marker
    const url = signRequest('GET', '/', { host: HOST }, secretId, secretKey, parameters)
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`COS 列表请求失败（HTTP ${response.status}）`)
    const xml = await response.text()
    if (!xml.includes('<ListBucketResult')) throw new Error('COS 列表响应无效')
    const page = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
    for (const [, block] of page) {
      const key = xmlValue(block, 'Key')
      const match = key?.match(/^kayoko\/kayoko_(\d+)\.(png|jpg|jpeg|webp|gif)$/)
      if (match) images.push({ id: Number(match[1]), key, size: Number(xmlValue(block, 'Size')) })
    }
    if (xmlValue(xml, 'IsTruncated') !== 'true') break
    const nextMarker = xmlValue(xml, 'NextMarker') || xmlValue(page.at(-1)?.[1] || '', 'Key')
    if (!nextMarker || nextMarker === marker) throw new Error('COS 列表分页失败')
    marker = nextMarker
  } while (true)
  return images
}

async function sha256OfCosImage(key) {
  const response = await fetch(`https://${HOST}/${key}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) })
  if (!response.ok || !response.body) throw new Error(`COS 图片读取失败（HTTP ${response.status}）`)
  const hash = crypto.createHash('sha256')
  for await (const chunk of response.body) hash.update(chunk)
  return hash.digest('hex')
}

export function signRequest(method, path, headers, secretId, secretKey, parameters = {}) {
  const now = Math.floor(Date.now() / 1000)
  const keyTime = `${now};${now + 60}`
  const signedHeaders = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort(([a], [b]) => a.localeCompare(b))
  const headerList = signedHeaders.map(([key]) => key).join(';')
  const httpHeaders = signedHeaders.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  const signedParameters = Object.entries(parameters)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort(([a], [b]) => a.localeCompare(b))
  const paramList = signedParameters.map(([key]) => key).join(';')
  const httpParameters = signedParameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  const httpString = `${method.toLowerCase()}\n${path}\n${httpParameters}\n${httpHeaders}\n`
  const stringToSign = `sha1\n${keyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`
  const signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex')
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex')
  const query = new URLSearchParams({
    'q-sign-algorithm': 'sha1',
    'q-ak': secretId,
    'q-sign-time': keyTime,
    'q-key-time': keyTime,
    'q-header-list': headerList,
    'q-url-param-list': paramList,
    'q-signature': signature
  })
  const objectParameters = new URLSearchParams(parameters).toString()
  return `https://${HOST}${path}?${objectParameters ? `${objectParameters}&` : ''}${query}`
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
  const sha256 = input?.sha256
  if (!Object.hasOwn(MIME, extension) || !Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    return reply({ error: '只支持 20 MB 内的 PNG、JPEG、WebP、GIF 图片' }, 400)
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    return reply({ error: '图片校验值无效' }, 400)
  }

  try {
    const images = await listImages(secretId, secretKey)
    for (const image of images) {
      if (image.size === size && await sha256OfCosImage(image.key) === sha256) {
        return reply({ error: `图片已存在（编号 ${image.id}）`, existingId: image.id }, 409)
      }
    }
    const id = images.reduce((max, image) => Math.max(max, image.id), 0) + 1
    if (id > 99999) throw new Error('图片编号已超出支持范围')
    const path = `/${PREFIX}${String(id).padStart(3, '0')}.${extension}`
    const headersToSign = {
      'host': HOST,
      'content-length': String(size),
      'content-type': MIME[extension],
      'x-cos-content-sha256': sha256,
      'x-cos-forbid-overwrite': 'true'
    }
    const uploadUrl = signRequest('PUT', path, headersToSign, secretId, secretKey)
    return reply({
      id,
      extension,
      filename: `kayoko_${String(id).padStart(3, '0')}.${extension}`,
      uploadUrl,
      headers: { 'Content-Type': MIME[extension], 'x-cos-content-sha256': sha256, 'x-cos-forbid-overwrite': 'true' }
    }, 200)
  } catch (error) {
    console.error('[JRRP website] 无法生成上传授权:', error)
    return reply({ error: '无法检查图库或生成上传授权，请稍后重试' }, 502)
  }
}
