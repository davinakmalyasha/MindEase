import sanitizeHtml from "sanitize-html";

export const sanitize = (input: unknown): string => {
    if (typeof input !== "string") return "";
    return sanitizeHtml(input.trim(), {
        allowedTags: [],
        allowedAttributes: {},
    }).slice(0, 4000);
};
