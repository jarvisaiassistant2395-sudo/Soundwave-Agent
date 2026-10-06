import { Link } from "react-router-dom";
import { Navbar } from "../components/layout/Navbar";
import { Search } from "lucide-react";

export function NotFound() {
  return (
    <div className="min-h-screen bg-navy">
      <Navbar />
      <div className="flex min-h-[80vh] flex-col items-center justify-center px-4 text-center">
        <p className="text-6xl font-extrabold text-gradient">404</p>
        <h1 className="mt-4 text-3xl font-bold text-white">Page not found</h1>
        <p className="mt-2 max-w-md text-gray-400">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            to="/"
            className="inline-flex h-11 items-center justify-center rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-6 font-semibold text-white hover:from-blue-400 hover:to-violet-400"
          >
            Back to home
          </Link>
          <Link
            to="/voices"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-btn border border-gray-600 px-6 font-semibold text-gray-200 hover:border-blue-500/70 hover:text-white"
          >
            <Search className="h-4 w-4" /> Browse voices
          </Link>
        </div>
      </div>
    </div>
  );
}
