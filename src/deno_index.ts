import { serve } from "https://deno.land/std@0.202.0/http/server.ts";

const TARGET_URL = "https://grok.com";
const ORIGIN_DOMAIN = "grok.com"; 

const AUTH_USERNAME = Deno.env.get("AUTH_USERNAME");
const AUTH_PASSWORD = Deno.env.get("AUTH_PASSWORD");
const COOKIE = Deno.env.get("cookie");

// 验证函数
function isValidAuth(authHeader: string): boolean {
  try {
    const base64Credentials = authHeader.split(" ")[1];
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(":");
    return username === AUTH_USERNAME && password === AUTH_PASSWORD;
  } catch {
    return false;
  }
}

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  const url = new URL(req.url);
  const targetUrl = `wss://grok.com${url.pathname}${url.search}`;

  console.log('Target URL:', targetUrl);

  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);

  targetWs.onopen = () => {
    console.log('Connected to grok');
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    console.log('Client message received');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    console.log('message received');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = (event) => {
    console.log('Client connection closed');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  };

  targetWs.onclose = (event) => {
    console.log('connection closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(event.code, event.reason);
    }
  };

  targetWs.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  return response;
}

const handler = async (req: Request): Promise<Response> => {
  // 1. OPTIONS 预检请求跨域拦截
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }
  
  const url = new URL(req.url);
  
  // 健康检查响应
  if (url.pathname === "/") {
    return new Response("Grok proxy is running!", { 
      status: 200, 
      headers: { "Access-Control-Allow-Origin": "*" } 
    });
  }

  // Basic Auth 验证
  const authHeader = req.headers.get("Authorization");
  if (AUTH_USERNAME && AUTH_PASSWORD && (!authHeader || !isValidAuth(authHeader))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Proxy Authentication Required"',
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

  // 构造代理请求
  const headers = new Headers(req.headers);
  headers.set("Host", targetUrl.host);
  headers.delete("Referer");
  headers.delete("Cookie");
  headers.delete("Authorization"); 
  headers.set("cookie", COOKIE || '');

  try {
    const proxyResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(proxyResponse.headers);
    responseHeaders.delete("Content-Length"); 
    const location = responseHeaders.get("Location");
    if (location) {
      responseHeaders.set("Location", location.replace(TARGET_URL, `https://${ORIGIN_DOMAIN}`));
    }
    
    // 强制写入所有响应跨域许可
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Headers", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

    if ([204, 205, 304].includes(proxyResponse.status)) {
      return new Response(null, { status: proxyResponse.status, headers: responseHeaders });
    }

    const transformStream = new TransformStream({
      transform: async (chunk, controller) => {
        const contentType = responseHeaders.get("Content-Type") || "";
        if (contentType.startsWith("text/") || contentType.includes("json")) {
          let text = new TextDecoder("utf-8", { stream: true }).decode(chunk);
          controller.enqueue(
            new TextEncoder().encode(text.replaceAll(TARGET_URL, ORIGIN_DOMAIN))
          );
        } else {
          controller.enqueue(chunk);
        }
      }
    });

    const readableStream = proxyResponse.body?.pipeThrough(transformStream);

    return new Response(readableStream, {
      status: proxyResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    // 异常报错带跨域
    return new Response(`Proxy Error: ${(error as Error).message}`, { 
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      }
    });
  }
};

Deno.serve(handler);
