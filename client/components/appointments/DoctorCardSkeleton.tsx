"use client";

export default function DoctorCardSkeleton() {
    return (
        <div className="bg-white rounded-3xl border border-gray-100 p-6 animate-pulse">
            <div className="flex flex-col md:flex-row gap-6">
                {/* Avatar Skeleton */}
                <div className="w-full md:w-32 aspect-square rounded-2xl bg-gray-100" />

                {/* Content Skeleton */}
                <div className="flex-1 space-y-4">
                    <div className="flex justify-between items-start">
                        <div className="space-y-2">
                            <div className="h-5 w-40 bg-gray-100 rounded-lg" />
                            <div className="h-3 w-24 bg-gray-100 rounded-lg" />
                        </div>
                        <div className="h-7 w-14 bg-amber-50 rounded-lg" />
                    </div>
                    <div className="space-y-2">
                        <div className="h-3 w-full bg-gray-50 rounded-lg" />
                        <div className="h-3 w-3/4 bg-gray-50 rounded-lg" />
                    </div>
                    <div className="flex gap-3">
                        <div className="h-8 w-32 bg-gray-50 rounded-full" />
                        <div className="h-8 w-28 bg-gray-50 rounded-full" />
                    </div>
                </div>

                {/* Action Skeleton */}
                <div className="flex md:flex-col justify-between items-center md:items-end border-t md:border-t-0 md:border-l border-gray-100 pt-4 md:pt-0 md:pl-6 gap-4">
                    <div className="space-y-1 text-right">
                        <div className="h-3 w-10 bg-gray-100 rounded ml-auto" />
                        <div className="h-6 w-24 bg-gray-100 rounded-lg" />
                    </div>
                    <div className="flex flex-col gap-2 w-full">
                        <div className="h-12 w-full bg-indigo-50 rounded-2xl" />
                        <div className="h-10 w-full bg-gray-50 rounded-2xl" />
                    </div>
                </div>
            </div>
        </div>
    );
}
