import type { FastifyInstance } from 'fastify';
import { transcribeAudio } from '../lib/stt.js';

export function registerSpeechRoutes(app: FastifyInstance): void {
  app.post('/v1/speech/transcribe', { preHandler: app.authenticate }, async (req, reply) => {
    try {
      const contentType = (req.headers['content-type'] || 'audio/m4a').split(';')[0]!;
      const buffer = req.body as Buffer;

      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        return reply.code(400).send({ error: 'Audio payload empty or invalid' });
      }

      const groqKey = (req.headers['x-groq-api-key'] as string) || process.env.GROQ_API_KEY;

      const text = await transcribeAudio(
        {
          buffer,
          mimeType: contentType,
        },
        groqKey
      );

      return { text: text || '' };
    } catch (err) {
      console.error('[Speech] Transcription route error:', err);
      return reply.code(500).send({ error: 'Failed to process audio' });
    }
  });
}
