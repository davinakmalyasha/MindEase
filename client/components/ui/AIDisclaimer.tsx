import { Info } from "lucide-react";

export default function AIDisclaimer({ compact = false }: { compact?: boolean }) {
    return (
        <div
            className={`rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 text-amber-700 dark:text-amber-300 ${
                compact ? "px-4 py-3 text-xs" : "px-5 py-4 text-sm"
            }`}
        >
            <p className="flex items-start gap-2 leading-relaxed">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                    <strong>AI-generated content for guidance only.</strong> These insights are generated
                    by AI and are not a diagnosis, medical advice, or a substitute for professional
                    psychological care. Always discuss your situation with your licensed psychologist.
                </span>
            </p>
        </div>
    );
}
