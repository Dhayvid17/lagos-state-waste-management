import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

// ── Preserves raw request body buffer for HMAC webhook verification
// Must be applied BEFORE any body parser touches the request
// Without this, signature verification fails because the body
// has been parsed and re-serialized (different bytes)

@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RawBodyMiddleware.name);

  use(req: Request, _res: Response, next: NextFunction): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      // Attach raw body to request object for use in webhook handlers
      (req as any).rawBody = Buffer.concat(chunks);

      this.logger.debug(`Raw body captured for ${req.path} — ${(req as any).rawBody.length} bytes`);

      next();
    });

    req.on('error', (err) => {
      this.logger.error(`Raw body capture error: ${err.message}`);
      next(err);
    });
  }
}
