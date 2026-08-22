export type AssessmentType = "phq9" | "gad7";

export interface AssessmentQuestion {
    text: string;
}

export interface AssessmentMeta {
    id: AssessmentType;
    name: string;
    description: string;
    maxScore: number;
    questions: AssessmentQuestion[];
}

const OPTIONS = ["Not at all", "Several days", "More than half the days", "Nearly every day"];

export const OPTION_LABELS = OPTIONS;

export const ASSESSMENTS: Record<AssessmentType, AssessmentMeta> = {
    phq9: {
        id: "phq9",
        name: "PHQ-9",
        description: "Patient Health Questionnaire — screens for depression severity over the past two weeks.",
        maxScore: 27,
        questions: [
            { text: "Little interest or pleasure in doing things" },
            { text: "Feeling down, depressed, or hopeless" },
            { text: "Trouble falling or staying asleep, or sleeping too much" },
            { text: "Feeling tired or having little energy" },
            { text: "Poor appetite or overeating" },
            { text: "Feeling bad about yourself — or that you are a failure or have let yourself or your family down" },
            { text: "Trouble concentrating on things, such as reading or watching television" },
            { text: "Moving or speaking so slowly that other people could have noticed. Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual" },
            { text: "Thoughts that you would be better off dead, or of hurting yourself in some way" },
        ],
    },
    gad7: {
        id: "gad7",
        name: "GAD-7",
        description: "Generalized Anxiety Disorder questionnaire — screens for anxiety severity over the past two weeks.",
        maxScore: 21,
        questions: [
            { text: "Feeling nervous, anxious, or on edge" },
            { text: "Not being able to stop or control worrying" },
            { text: "Worrying too much about different things" },
            { text: "Trouble relaxing" },
            { text: "Being so restless that it is hard to sit still" },
            { text: "Becoming easily annoyed or irritable" },
            { text: "Feeling afraid, as if something awful might happen" },
        ],
    },
};

export const severityLabel = (type: AssessmentType, severity: string) => {
    if (type === "phq9") {
        const map: Record<string, string> = {
            minimal: "Minimal",
            mild: "Mild",
            moderate: "Moderate",
            "moderately-severe": "Moderately severe",
            severe: "Severe",
        };
        return map[severity] || severity;
    }
    const map: Record<string, string> = {
        minimal: "Minimal",
        mild: "Mild",
        moderate: "Moderate",
        severe: "Severe",
    };
    return map[severity] || severity;
};
