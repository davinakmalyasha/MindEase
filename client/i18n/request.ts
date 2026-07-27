import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const locale = cookieStore.get("locale")?.value === "id" ? "id" : "en";

    let messages = {};
    try {
        messages = (await import(`../messages/${locale}.json`)).default;
    } catch {
        messages = {};
    }

    return { locale, messages };
});
