import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is not set in environment variables');
}

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Função auxiliar para criar delays naturais
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Função para dividir texto em chunks naturais
function splitIntoNaturalChunks(text: string): string[] {
  // Divide o texto em sentenças ou parágrafos
  const sentences = text.match(/[^.!?]+[.!?]+|\n+/g) || [];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > 100) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    const chatCompletion = await groq.chat.completions.create({
      model: 'deepseek-r1-distill-llama-70b',
      messages,
      max_tokens: 4000,
      temperature: 0.7,
    });

    if (!chatCompletion || !chatCompletion.choices) {
      throw new Error('No valid response from Groq');
    }

    const responseContent = chatCompletion.choices[0]?.message?.content || '';
    const encoder = new TextEncoder();

    // Separar o conteúdo em "thinking" e "response"
    const thinkMatch = responseContent.match(/<think>([\s\S]*?)<\/think>/);
    const thinking = thinkMatch ? thinkMatch[1].trim() : '';
    const response = responseContent.replace(/<think>[\s\S]*?<\/think>/, '').trim();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Processar o thinking primeiro
          if (thinking) {
            const thinkingChunks = splitIntoNaturalChunks(thinking);
            for (const chunk of thinkingChunks) {
              // Simular velocidade de digitação variável
              const typingDelay = Math.random() * 30 + 20; // 20-50ms por chunk
              await delay(typingDelay);

              const thinkingResponse = {
                choices: [{
                  delta: {
                    reasoning_content: chunk
                  }
                }]
              };
              controller.enqueue(encoder.encode(JSON.stringify(thinkingResponse) + '\n'));
            }

            // Pequena pausa entre thinking e resposta
            await delay(500);
          }

          // Processar a resposta principal
          const responseChunks = splitIntoNaturalChunks(response);
          for (const chunk of responseChunks) {
            // Simular velocidade de digitação natural
            const words = chunk.split(' ').length;
            const typingDelay = (Math.random() * 20 + 10) * words; // Delay baseado no número de palavras
            await delay(typingDelay);

            const contentResponse = {
              choices: [{
                delta: {
                  content: chunk
                }
              }]
            };
            controller.enqueue(encoder.encode(JSON.stringify(contentResponse) + '\n'));

            // Adicionar pequenas pausas em pontuações
            if (chunk.match(/[.!?]\s*$/)) {
              await delay(200); // Pausa maior no fim das sentenças
            }
          }

          // Sinalizar o fim do stream
          controller.enqueue(encoder.encode(JSON.stringify({ choices: [{ delta: { content: '' } }] }) + '\n'));
          controller.close();
        } catch (error) {
          console.error('Streaming error:', error);
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process request' },
      { status: 500 }
    );
  }
}