import type { FastifyInstance } from 'fastify';
import { transcribeAudio } from '../lib/stt.js';

export function registerSpeechRoutes(app: FastifyInstance): void {
  app.post('/v1/speech/transcribe', { preHandler: app.authenticate }, async (req, reply) => {
    try {
      const contentType = req.headers['content-type'] || 'audio/m4a';
      const buffer = await req.toBuffer();

      if (!buffer || buffer.length === 0) {
        return reply.code(400).send({ error: 'Audio payload empty' });
      }

      const text = await transcribeAudio({
        buffer,
        mimeType: contentType.split(';')[0],
      });

      return { text: text || '' };
    } catch (err) {
      console.error('[Speech] Transcription route error:', err);
      return reply.code(500).send({ error: 'Failed to process audio' });
    }
  });
}
