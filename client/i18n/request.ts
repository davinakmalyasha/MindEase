import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

/**
 * `timeZone` was never set here, so next-intl logged
 * `ENVIRONMENT_FALLBACK: There is no timeZone configured, this can lead to
 * markup mismatches` on every single page render.
 *
 * It is not a cosmetic warning. Without it, `next-intl` falls back to the
 * server's zone during SSR and the browser's zone on the client, so any string
 * built from `useFormatter` - and this app formats appointment times, mood
 * entries and journal timestamps - can render differently in the two passes.
 * That is a hydration mismatch with a real user-visible consequence: a time that
 * says 09:00 in the HTML and 02:00 after hydration.
 *
 * `Asia/Jakarta` matches the locale this product is written for and matches the
 * scheduler: the API registers its cron jobs with `TZ=Asia/Jakarta`, so pinning
 * the formatter to the same zone keeps "09:00 on the reminder" and "09:00 on the
 * screen" the same 09:00.
 */
const TIME_ZONE = process.env.NEXT_PUBLIC_TIME_ZONE || "Asia/Jakarta";

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const locale = cookieStore.get("locale")?.value === "id" ? "id" : "en";

    let messages = {};
    try {
        messages = (await import(`../messages/${locale}.json`)).default;
    } catch {
        messages = {};
    }

    return { locale, messages, timeZone: TIME_ZONE };
});
