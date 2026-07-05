declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string | null;
        phone?: string | null;
        name?: string | null;
      };
    }
  }
}

export {};
