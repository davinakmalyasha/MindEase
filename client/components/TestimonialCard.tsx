import Image from "next/image";
import { Star } from "lucide-react";

interface TestimonialCardProps {
    quote: string;
    name: string;
    role: string;
    rating: number;
    avatarUrl: string;
}

export default function TestimonialCard({
    quote,
    name,
    role,
    rating,
    avatarUrl,
}: TestimonialCardProps) {
    return (
        <div className="bg-white shadow-sm rounded-2xl p-5 w-[320px] flex flex-col gap-3 border border-gray-100">
            {/* Quote and Avatar Row */}
            <div className="flex gap-3 items-start">
                <p className="text-gray-600 text-xs leading-relaxed flex-1">{quote}</p>
                <div className="w-10 h-10 rounded-full overflow-hidden flex-shrink-0">
                    <Image
                        src={avatarUrl}
                        alt={name}
                        width={40}
                        height={40}
                        className="object-cover w-full h-full"
                    />
                </div>
            </div>

            {/* Rating and Role Row */}
            <div className="flex items-center justify-between">
                <div className="flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, index) => (
                        <Star
                            key={index}
                            size={14}
                            className={
                                index < rating
                                    ? "fill-amber-400 text-amber-400"
                                    : "fill-gray-200 text-gray-200"
                            }
                        />
                    ))}
                </div>
                <span className="bg-green-100 text-green-700 text-xs font-medium px-4 py-1.5 rounded-full">
                    {role}
                </span>
            </div>
        </div>
    );
}
