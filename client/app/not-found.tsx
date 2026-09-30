import Link from "next/link";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";

export default function NotFound() {
    return (
        <main className="min-h-screen bg-white flex flex-col">
            <Navbar />
            <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
                <p className="text-[10rem] leading-none font-black text-gray-100 select-none">404</p>
                <h1 className="text-3xl font-extrabold text-gray-900 -mt-8 mb-3">Page not found</h1>
                <p className="text-gray-500 mb-8 max-w-sm">
                    The page you&apos;re looking for doesn&apos;t exist or has been moved.
                </p>
                <div className="flex gap-3">
                    <Link
                        href="/"
                        className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                    >
                        Back to Home
                    </Link>
                    <Link
                        href="/doctors"
                        className="px-6 py-3 bg-gray-100 text-gray-700 rounded-2xl font-bold hover:bg-gray-200 transition-all"
                    >
                        Find a Doctor
                    </Link>
                </div>
            </div>
            <Footer />
        </main>
    );
}
