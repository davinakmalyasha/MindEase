declare global {
    namespace Express {
        interface Request {
            user?: {
                id: number;
                role: string;
                email: string;
                name?: string | null;
                doctorProfileId?: number | null;
            };
        }
    }
}

export {};
