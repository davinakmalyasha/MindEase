export default function DoctorCardSkeleton() {
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-5 animate-pulse">
            <div className="flex items-start gap-4 mb-4">
                <div className="w-14 h-14 rounded-full bg-gray-200 shrink-0" />
                <div className="flex-1 space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-3/4" />
                    <div className="h-3 bg-gray-200 rounded w-1/2" />
                    <div className="h-3 bg-gray-200 rounded w-1/3" />
                </div>
            </div>
            <div className="space-y-2 mb-4">
                <div className="h-3 bg-gray-200 rounded w-full" />
                <div className="h-3 bg-gray-200 rounded w-4/5" />
            </div>
            <div className="flex justify-between mb-4">
                <div className="h-3 bg-gray-200 rounded w-16" />
                <div className="h-5 bg-gray-200 rounded-full w-20" />
            </div>
            <div className="flex justify-between pt-4 border-t border-gray-50">
                <div className="h-5 bg-gray-200 rounded w-20" />
                <div className="h-8 bg-gray-200 rounded-full w-24" />
            </div>
        </div>
    );
}
