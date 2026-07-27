export default function sitemap() {
    const base = "https://mindease.app";
    const staticRoutes = [
        "",
        "/login",
        "/register",
        "/doctors",
        "/appointments",
        "/forgot-password",
    ];
    return staticRoutes.map((route) => ({
        url: `${base}${route}`,
        lastModified: new Date(),
        changeFrequency: "weekly" as const,
        priority: route === "" ? 1 : 0.8,
    }));
}
