import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../src/app';

// Wrap Express app for Vercel serverless
export default async function handler(req: VercelRequest, res: VercelResponse) {
    return new Promise((resolve, reject) => {
        app(req, res, (err: any) => {
            if (err) return reject(err);
            resolve(undefined);
        });
    });
}