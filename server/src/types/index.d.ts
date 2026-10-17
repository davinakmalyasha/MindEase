declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                role: string;
                email: string;
                name?: string | null;
                doctorProfileId?: string | null;
            };
        }
    }
}

export {};
