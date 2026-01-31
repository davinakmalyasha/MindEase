import Link from "next/link";
import "./css/index.css";


export default function Home() {
  return (
    <div className="container">
      <div className="topbar">
        <div className="kiriNavbar">
          <div className="brand">
          <h4>MindEase</h4>
          <img src="ImgOrIcon/Union.png"/>
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
          <img className="tengahHeroimg" src="ImgOrIcon/tengahHero.png"/>
        </div>
        <div className="kananHero">
          <div className="doktorLogin">
            <div className="kiriDoktorLogin">
              <h4>Are u a Doctor?</h4>
              <hr />
              <h4>lets give people some warm thought</h4>
            </div>
              <div className="bungkusSVG">
              <svg xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 24 24" fill="none" stroke="#000000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right-icon lucide-arrow-up-right"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>
              </div>
          </div>
          <img className="kananHeroimg" src="ImgOrIcon/kananHero.png"/>
        </div>

      </div>

      <div className="introductionSection">
        <h1>What`s MindEase?</h1>

        <div className="mainIntro">
          <img className="introImg" src="ImgOrIcon/kananHero.png"/>
          <h4>A bridge for those seeking to consult their mental health with qualified psychologists and experts. We connect you to professional support for a better understanding of your mental well-being.</h4>
        </div>
        
      </div>

      <div className="promoSection">
        <div className="promoHeader">
          <h1>Here’ what you  can do with our Mental health care services</h1>
          <button>Explore <img src="" alt="" /></button>
        </div>
        <div className="promoContent">
          <div className="promoCard">
            
          </div>
        </div>
      </div>

    

        

        {/* <Link href="/register">
          <button>
            Daftar Akun
          </button>
        </Link> */}
      </div>
  );
}
