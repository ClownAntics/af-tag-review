import { GoogleSignInButton } from "@/components/GoogleSignInButton";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "That account isn't a @clownantics.com address. Sign in with your ClownAntics Google account.",
  missing_code: "Sign-in didn't complete. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const message = error ? (ERROR_MESSAGES[error] ?? decodeURIComponent(error)) : null;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-medium">Tag Review</h1>
        <p className="text-sm text-muted mt-1 mb-6">
          Sign in with your ClownAntics Google account to continue.
        </p>
        {message && (
          <p className="text-sm text-[#A32D2D] bg-[#FBEAEA] border border-[#F0C9C9] rounded-md px-3 py-2 mb-4">
            {message}
          </p>
        )}
        <GoogleSignInButton next={next} />
      </div>
    </div>
  );
}
