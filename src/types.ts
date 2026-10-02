export interface User {
    timezone?: string;
    id: string;
    name: string;
    email: string;
    companyId?: string;
    companyName?: string;
    companyLogoUrl?: string | null;
}
