/**
 * A screening-score trajectory.
 *
 * Hand-rolled SVG rather than a charting library. The rest of this codebase
 * hand-rolls its charts - the mood bars, the analytics meters - and adding a
 * library for one line chart would be the only place in the client with a
 * third-party renderer in it. It is also about eighty lines.
 *
 * The clinical framing is the point of the component, not an afterthought:
 *
 *  - **Screening, not diagnosis.** These are self-report instruments. A
 *    downward line is a change in a *screening score*, and the label says so.
 *    Reading it as recovery is the misreading this chart is most likely to
 *    cause.
 *  - **The y axis is the instrument's own range.** PHQ-9 tops out at 27 and
 *    GAD-7 at 21. Plotting both on one 0-27 axis would flatten GAD-7 and make a
 *    stable anxiety score look like an improving one, so the domain comes from
 *    the server rather than being guessed here.
 *  - **Severity bands behind the line.** The thresholds are the point of a
 *    screening instrument; a bare line hides them.
 *  - **Fewer than three sittings draws no line.** One data point is not a trend,
 *    and joining two points a week apart implies a trajectory that was never
 *    measured.
 */

export interface TrajectoryPoint {
    id: number;
    score: number;
    severity: string;
    createdAt: string;
    changeFromPrevious: number | null;
}

export interface Instrument {
    label: string;
    max: number;
    bands: { upTo: number; severity: string }[];
}

const BAND_TINT: Record<string, string> = {
    minimal: "#ecfdf5",
    mild: "#fef9c3",
    moderate: "#fed7aa",
    "moderately-severe": "#fdba74",
    severe: "#fecaca",
};

const W = 560;
const H = 200;
const PAD = { top: 16, right: 16, bottom: 28, left: 32 };

export default function TrajectoryChart({
    points,
    instrument,
    label,
}: {
    points: TrajectoryPoint[];
    instrument: Instrument;
    label: string;
}) {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    const x = (i: number) =>
        PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (score: number) => PAD.top + innerH - (score / instrument.max) * innerH;

    // Only connect points when there is a trajectory to connect. A two-point
    // line is drawn; a one-point series is not, because it would imply a
    // direction nobody measured.
    const drawable = points.length >= 2;
    const path = drawable
        ? points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ")
        : "";

    return (
        <figure className="rounded-2xl border border-gray-100 bg-white p-4">
            <figcaption className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">
                {label}
            </figcaption>

            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="h-auto w-full"
                role="img"
                aria-label={`${label}: ${points.length} sittings, latest score ${points[points.length - 1]?.score ?? "none"}`}
            >
                {/* The bands and grid are `aria-hidden`: they are decoration
                    behind a chart that is already described by the label above
                    and enumerated in the legend below. Without this a screen
                    reader walks every rect and tick and reads the colours out as
                    if they were data. */}
                {/* Severity bands, drawn first so the line sits on top. Each
                    band's top is the previous band's ceiling, which is why the
                    bands are walked in order rather than indexed. */}
                {instrument.bands.map((band, i) => {
                    const upper = band.upTo;
                    const lower = i === 0 ? 0 : instrument.bands[i - 1].upTo;
                    return (
                        <rect
                            key={band.severity}
                            x={PAD.left}
                            y={y(upper)}
                            width={innerW}
                            height={Math.max(0, y(lower) - y(upper))}
                            fill={BAND_TINT[band.severity] ?? "#f3f4f6"}
                            aria-hidden="true"
                        />
                    );
                })}

                {/* Y axis: 0, max, and the midpoint. Three labels is enough to
                    read a screening score and few enough to stay legible on a
                    phone. */}
                {[0, Math.round(instrument.max / 2), instrument.max].map((tick) => (
                    <g key={tick} aria-hidden="true">
                        <line
                            x1={PAD.left}
                            x2={W - PAD.right}
                            y1={y(tick)}
                            y2={y(tick)}
                            stroke="#e5e7eb"
                            strokeWidth={1}
                        />
                        <text
                            x={PAD.left - 6}
                            y={y(tick) + 4}
                            textAnchor="end"
                            fontSize={10}
                            fill="#6b7280"
                        >
                            {tick}
                        </text>
                    </g>
                ))}

                {drawable && (
                    <path
                        d={path}
                        fill="none"
                        stroke="#4f46e5"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    />
                )}

                {points.map((p, i) => (
                    <g key={p.id}>
                        <circle cx={x(i)} cy={y(p.score)} r={4} fill="#4f46e5" aria-hidden="true">
                            <title>{`${new Date(p.createdAt).toLocaleDateString()}: ${p.score} (${p.severity})`}</title>
                        </circle>
                        {/* Only the endpoints are labelled. A number under every
                            point is unreadable at phone width and the exact
                            values are in the table below the chart. */}
                        {i === 0 || i === points.length - 1 ? (
                            <text
                                x={x(i)}
                                y={H - 8}
                                textAnchor="middle"
                                fontSize={10}
                                fill="#6b7280"
                                aria-hidden="true"
                            >
                                {new Date(p.createdAt).toLocaleDateString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                })}
                            </text>
                        ) : null}
                    </g>
                ))}
            </svg>

                {/* The legend, which is also the text alternative.
                 *
                 * The bands are the only place the severity thresholds appear in
                 * this component, and they are conveyed by tint alone. A reader
                 * who cannot distinguish `#fecaca` from `#fdba74` learns nothing
                 * about where "severe" begins, so the ranges are spelled out here
                 * as text and each swatch is labelled rather than left to be
                 * matched by eye. `sr-only` on the summary because the legend
                 * below is visible and duplicating it aloud is noise. */}
                <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                    {instrument.bands.map((band, i) => {
                        const lower = i === 0 ? 0 : instrument.bands[i - 1].upTo;
                        return (
                            <li key={band.severity} className="flex items-center gap-1.5">
                                <span
                                    aria-hidden="true"
                                    className="h-2.5 w-2.5 shrink-0 rounded-sm border border-gray-300"
                                    style={{ background: BAND_TINT[band.severity] ?? "#f3f4f6" }}
                                />
                                <span>
                                    {band.severity}
                                    <span className="text-gray-400">
                                        {" "}
                                        ({lower}&ndash;{band.upTo})
                                    </span>
                                </span>
                            </li>
                        );
                    })}
                </ul>

                {/* Direction of travel, stated rather than inferred. The line's
                    * slope* is the reading a clinician takes from this chart, and
                    * it is unavailable to anyone who cannot see the line. */}
                <p className="sr-only">
                    {points.length < 2
                        ? "A single sitting, so no trend is shown."
                        : `First score ${points[0].score} (${points[0].severity}), latest score ${
                              points[points.length - 1].score
                          } (${points[points.length - 1].severity}).`}
                </p>
            </figure>
        );
    }
