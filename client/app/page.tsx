import Link from "next/link";
import "./css/index.css";
import TestimonialCard from "@/components/TestimonialCard";

const TESTIMONIALS = [
  {
    id: 1,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "Sarah Johnson",
    rating: 5,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
  {
    id: 2,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "Michael Chen",
    rating: 5,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
  {
    id: 3,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "Emily Davis",
    rating: 4,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
  {
    id: 4,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "James Wilson",
    rating: 5,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
  {
    id: 5,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "Lisa Anderson",
    rating: 4,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
  {
    id: 6,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "David Martinez",
    rating: 5,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
  {
    id: 7,
    quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
    name: "Emma Thompson",
    rating: 5,
    role: "Student",
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
  },
];
export default function Home() {
  return (
    <div className="container">
      <div className="topbar">
        <div className="kiriNavbar">
          <div className="brand">
            <h4>MindEase</h4>
            <img src="ImgOrIcon/Union.png" />
          </div>
          <ul className="navList">
            <li>Home</li>
            <li>Doctor</li>
            <li>Appointment</li>
          </ul>
        </div>
        <button className="loginRegis" href="/login">
          SignIn/SignUp
        </button>
      </div>

      <div className="heroSection">
        <div className="kiriHero">
          <h1>START YOUR JOURNEY TO MENTAL CLARITY AND WELL BEING</h1>
          <button>Explore</button>
        </div>
        <div className="tengahHero">
          <img className="tengahHeroimg" src="ImgOrIcon/tengahHero.png" />
        </div>
        <div className="kananHero">
          <div className="doktorLogin">
            <div className="kiriDoktorLogin">
              <h4>Are u a Doctor?</h4>
              <hr />
              <h4>lets give people some warm thought</h4>
            </div>
            <div className="bungkusSVG">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right-icon lucide-arrow-up-right"><path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>
            </div>
          </div>
          <img className="kananHeroimg" src="ImgOrIcon/kananHero.png" />
        </div>

      </div>

      <div className="introductionSection">
        <h1>What`s MindEase?</h1>

        <div className="mainIntro">
          <img className="introImg" src="ImgOrIcon/kananHero.png" />
          <h4>A bridge for those seeking to consult their mental health with qualified psychologists and experts. We connect you to professional support for a better understanding of your mental well-being.</h4>
        </div>
      </div>

      <div className="promoSection">
        <div className="promoHeader">
          <h1>Here’ what you  can do with our Mental health care services</h1>
          <Link className="buttonPromoHeader" href="/">
            Explore
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right-icon lucide-arrow-up-right"><path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>
          </Link>
        </div>
        <div className="promoContent">
          <div className="promoCard">
            <img src="ImgOrIcon/foto1Promo.png" alt="" />
            <div className="textKananPromo">
              <h4>Telepathy Platforms</h4>
            </div>
          </div>
          <div className="promoCard">
            <img src="ImgOrIcon/foto1Promo.png" alt="" />
            <div className="textKananPromo">
              <h4>Telepathy Platforms</h4>
            </div>
          </div>
          <div className="promoCard">
            <img src="ImgOrIcon/foto1Promo.png" alt="" />
            <div className="textKananPromo">
              <h4>Telepathy Platforms</h4>
            </div>
          </div>
          <div className="promoCard">
            <img src="ImgOrIcon/foto1Promo.png" alt="" />
            <div className="textKananPromo">
              <h4>Telepathy Platforms</h4>
            </div>
          </div>
        </div>
      </div>


      {/* Our Customers Said Section */}
      <section className="py-16 w-full">
        <div className="w-full">
          <h2 className="text-3xl md:text-4xl font-semibold italic text-center text-gray-900 mb-12" style={{ fontFamily: 'Georgia, serif' }}>
            Our Customers Said
          </h2>

          {/* Row 1 - 2 cards */}
          <div className="flex justify-center gap-8 mb-6">
            {TESTIMONIALS.slice(0, 2).map((testimonial) => (
              <TestimonialCard
                key={testimonial.id}
                quote={testimonial.quote}
                name={testimonial.name}
                role={testimonial.role}
                rating={testimonial.rating}
                avatarUrl={testimonial.avatarUrl}
              />
            ))}
          </div>

          {/* Row 2 - 3 cards */}
          <div className="flex justify-center gap-8 mb-6">
            {TESTIMONIALS.slice(2, 5).map((testimonial) => (
              <TestimonialCard
                key={testimonial.id}
                quote={testimonial.quote}
                name={testimonial.name}
                role={testimonial.role}
                rating={testimonial.rating}
                avatarUrl={testimonial.avatarUrl}
              />
            ))}
          </div>

          {/* Row 3 - 2 cards */}
          <div className="flex justify-center gap-8">
            {TESTIMONIALS.slice(5, 7).map((testimonial) => (
              <TestimonialCard
                key={testimonial.id}
                quote={testimonial.quote}
                name={testimonial.name}
                role={testimonial.role}
                rating={testimonial.rating}
                avatarUrl={testimonial.avatarUrl}
              />
            ))}
          </div>
        </div>
      </section>
      {/* CTA Footer Section */}
      <section className="relative w-full py-20 overflow-hidden bg-white">
        {/* Decorative Blobs - Left Side */}
        <div className="absolute left-0 top-0 bottom-0 w-48 flex flex-col justify-center gap-4 -translate-x-1/3">
          <div className="w-24 h-48 rounded-full bg-gradient-to-b from-indigo-400 via-purple-500 to-indigo-600"></div>
          <div className="w-32 h-40 rounded-full bg-gradient-to-br from-teal-200 to-emerald-300 -translate-y-4 translate-x-12"></div>
        </div>

        {/* Decorative Blobs - Right Side */}
        <div className="absolute right-0 top-0 bottom-0 w-48 flex flex-col justify-center gap-4 translate-x-1/3">
          <div className="w-32 h-40 rounded-full bg-gradient-to-br from-pink-200 via-pink-300 to-rose-300 translate-y-4"></div>
          <div className="w-24 h-48 rounded-full bg-gradient-to-b from-indigo-400 via-purple-500 to-indigo-600 translate-x-8"></div>
        </div>

        {/* Center Content */}
        <div className="relative z-10 flex flex-col items-center justify-center text-center px-8">
          <p className="text-gray-500 text-sm mb-4 italic" style={{ fontFamily: 'Georgia, serif' }}>
            Are you ready?
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4 max-w-lg leading-tight">
            To improving your mental well-being
          </h2>
          <p className="text-gray-500 text-sm max-w-md mb-8">
            Join Thousands of our User who already using Mind Ease to Improve their mental well-being
          </p>
          <div className="flex gap-4">
            <button className="bg-gray-900 text-white px-8 py-3 rounded-full font-medium hover:bg-gray-800 transition-colors">
              Consult Now
            </button>
            <button className="bg-white text-gray-900 px-8 py-3 rounded-full font-medium border border-gray-300 hover:bg-gray-50 transition-colors">
              Lets Talk
            </button>
          </div>
        </div>
      </section>

      {/* <Link href="/register">
          <button>
            Daftar Akun
          </button>
        </Link> */}
    </div>
  );
}
