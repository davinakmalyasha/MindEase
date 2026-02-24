import Navbar from "@/components/layout/Navbar";
import HeroSection from "@/components/HeroSection";
import IntroductionSection from "@/components/home/IntroductionSection";
import PromoSection from "@/components/home/PromoSection";
import ReviewsSection from "@/components/home/ReviewsSection";
import Footer from "@/components/layout/Footer";
import BottomBar from "@/components/layout/BottomBar";

export default function Home() {
  return (
    <main className="w-full flex flex-col items-center bg-white min-h-screen text-black font-sans overflow-x-hidden">
      <Navbar />
      <HeroSection />
      <div className="w-full max-w-[90%] mx-auto flex flex-col">
        <IntroductionSection />
        <PromoSection />
      </div>
      <ReviewsSection />
      <Footer />
    </main>
  );
}
