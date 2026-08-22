export default function sitemap() {
    const base = process.env.NEXT_PUBLIC_SITE_URL || "https://mindease.app";
    const staticRoutes = [
        "",
        "/login",
        "/register",
        "/doctors",
        "/appointments",
        "/forgot-password",
        "/crisis",
        "/privacy",
        "/terms",
        "/about",
        "/faq",
        "/contact",
        "/help",
    ];
    return staticRoutes.map((route) => ({
        url: `${base}${route}`,
        lastModified: new Date(),
        changeFrequency: "weekly" as const,
        priority: route === "" ? 1 : 0.8,
    }));
}
