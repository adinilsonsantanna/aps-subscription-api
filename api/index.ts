import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../src/app';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return new Promise<void>((resolve, reject) => {
    app(req, res, (err: any) => {
      if (err) return reject(err);
      resolve();
    });
  });
}