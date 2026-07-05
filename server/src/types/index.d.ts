declare global {
    namespace Express {
        interface Request {
            user?: {
                id: number;
                role: string;
                email: string;
                doctorProfileId?: number | null;
            };
        }
    }
}

export {};
