import { NextResponse } from 'next/server';

const OLLAMA_API_URL = 'http://localhost:11434/api/chat';

// Aumentar o timeout para 5 minutos (mais que isso pode causar problemas com o Edge Runtime)
export const maxDuration = 300;

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Implementar rate limiting básico
const RATE_LIMIT = 5; // requisições por minuto
const requests = new Map<string, number[]>();

// Cache para controlar requisições ativas
const activeRequests = new Map<string, AbortController>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = requests.get(ip) || [];
  const recentRequests = timestamps.filter(t => now - t < 60000);
  
  if (recentRequests.length >= RATE_LIMIT) {
    return false;
  }
  
  requests.set(ip, [...recentRequests, now]);
  return true;
}

// Função para limpar requisições antigas periodicamente
setInterval(() => {
  const now = Date.now();
  requests.forEach((timestamps, ip) => {
    const filtered = timestamps.filter(t => now - t < 60000);
    if (filtered.length === 0) {
      requests.delete(ip);
    } else {
      requests.set(ip, filtered);
    }
  });
}, 60000);

export async function POST(req: Request) {
  const controller = new AbortController();
  const id = Date.now().toString();
  
  try {
    // Implementar rate limiting básico
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        { status: 429 }
      );
    }

    const { messages } = await req.json();

    // Validar e limitar o tamanho dos messages
    if (!Array.isArray(messages) || messages.length > 50) {
      return NextResponse.json(
        { error: 'Invalid or too many messages' },
        { status: 400 }
      );
    }

    // Limitar o tamanho total do conteúdo
    const totalContent = messages.reduce((acc, msg) => acc + (msg.content?.length || 0), 0);
    if (totalContent > 32000) {
      return NextResponse.json(
        { error: 'Total content size exceeds limit' },
        { status: 400 }
      );
    }

    activeRequests.set(id, controller);

    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-r1:1.5b',
        messages,
        stream: true,
        options: {
          temperature: 0.7,
          num_predict: 1000, // Reduzido para melhor performance
          num_ctx: 2048,     // Reduzido para melhor performance
          top_k: 40,         // Ajuste para melhor performance
          top_p: 0.9,        // Ajuste para melhor performance
          repeat_penalty: 1.1 // Evitar repetições
        }
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama error: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Implementar timeout por chunk
    const CHUNK_TIMEOUT = 10000; // 10 segundos
    
    const stream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const readPromise = reader.read();
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Chunk timeout')), CHUNK_TIMEOUT);
            });

            const { done, value } = await Promise.race([readPromise, timeoutPromise]) as any;
            if (done) break;

            const text = decoder.decode(value);
            const lines = text.split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                const content = parsed.message?.content || '';

                // Apenas envia se houver conteúdo
                if (content.trim()) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({
                      choices: [{
                        delta: { content, role: 'assistant' }
                      }]
                    })}\n\n`)
                  );
                }
              } catch (e) {
                console.error('Parse error:', e);
              }
            }
          }
        } catch (e) {
          console.error('Stream error:', e);
          // Envia mensagem de erro para o cliente
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              error: e instanceof Error ? e.message : 'Stream error'
            })}\n\n`)
          );
        } finally {
          controller.close();
          activeRequests.delete(id);
        }
      },
      cancel() {
        reader.cancel();
        activeRequests.delete(id);
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });

  } catch (error) {
    activeRequests.delete(id);
    console.error('API Error:', error);
    
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : 'Internal Server Error',
        advice: 'Verifique se o servidor Ollama está rodando e tente reduzir o tamanho da solicitação'
      },
      { status: 500 }
    );
  }
}