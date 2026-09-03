interface RateLimiter {
  requests: number;
  tokens: number;
  lastReset: number;
}

const rateLimiter: RateLimiter = {
  requests: 0,
  tokens: 0,
  lastReset: Date.now(),
};

// 固定目标地址
const TARGET_BASE_URL = "https://api.groq.com";

function estimateTokens(body: any): number {
  try {
    const messages = body?.messages || [];
    return messages.reduce((acc: number, msg: any) => 
      acc + (msg.content?.length || 0) * 0.25, 0);
  } catch {
    return 0;
  }
}

function resetCountersIfNeeded() {
  const now = Date.now();
  if (now - rateLimiter.lastReset >= 60000) {
    rateLimiter.requests = 0;
    rateLimiter.tokens = 0;
    rateLimiter.lastReset = now;
  }
}

async function processResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    const jsonData = await response.json();
    
    if (jsonData.choices && jsonData.choices[0]?.message?.content) {
      const content = jsonData.choices[0].message.content;
      const processedContent = content.replace(/<think>.*?<\/think>\s*/s, '').trim();
      jsonData.choices[0].message.content = processedContent;
    }

    return new Response(JSON.stringify(jsonData), {
      status: response.status,
      headers: response.headers
    });
  }
  
  return response;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 根路径返回提示
  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Proxy is Running！', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // 只要路径以 /v1 开头，就视为 API 请求
  if (pathname.startsWith('/v1')) {
    resetCountersIfNeeded();

    if (rateLimiter.requests >= 30) {
      return new Response('Rate limit exceeded. Max 30 requests per minute.', {
        status: 429,
        headers: {
          'Retry-After': '60',
          'Content-Type': 'application/json'
        }
      });
    }

    // 只有 POST 请求才去读取 body 计算 token
    if (request.method === 'POST') {
      try {
        const bodyClone = request.clone();
        const body = await bodyClone.json();
        const estimatedTokens = estimateTokens(body);

        if (rateLimiter.tokens + estimatedTokens > 6000) {
          return new Response('Token limit exceeded. Max 6000 tokens per minute.', {
            status: 429,
            headers: {
              'Retry-After': '60',
              'Content-Type': 'application/json'
            }
          });
        }

        rateLimiter.tokens += estimatedTokens;
      } catch (error) {
        console.error('Error parsing request body:', error);
      }
    }

    rateLimiter.requests++;
    
    // 核心修改点：将请求路径直接拼接到 groq 官网域名后面
    const targetUrl = `${TARGET_BASE_URL}${pathname}`;

    try {
      const headers = new Headers();
      const allowedHeaders = ['accept', 'content-type', 'authorization'];
      for (const [key, value] of request.headers.entries()) {
        if (allowedHeaders.includes(key.toLowerCase())) {
          headers.set(key, value);
        }
      }

      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.method === 'POST' ? request.body : undefined
      });

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Referrer-Policy', 'no-referrer');
      responseHeaders.set('X-RateLimit-Remaining', `${30 - rateLimiter.requests}`);
      responseHeaders.set('X-TokenLimit-Remaining', `${6000 - rateLimiter.tokens}`);

      const processedResponse = await processResponse(response);

      return new Response(processedResponse.body, {
        status: processedResponse.status,
        headers: responseHeaders
      });

    } catch (error) {
      console.error('Failed to fetch:', error);
      return new Response(JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      }), { 
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  }

  // 其他未匹配路径返回404
  return new Response('Not Found', { status: 404 });
}

Deno.serve(handleRequest);
