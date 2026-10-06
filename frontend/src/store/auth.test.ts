// ── Who is signed in ────────────────────────────────────────────────────────
// The store behind every gated page. Two behaviours matter enough to pin down:
// a failed session check must leave the app on the welcome screen rather than
// hanging on the spinner forever, and a second call while one is in flight must
// not fire a second request (two panels both mounting on load do this).
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();

vi.mock("../lib/api", () => ({ http: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
vi.mock("../lib/desktop", () => ({ openInBrowser: vi.fn(async () => true) }));

const { useAuth } = await import("./auth");

const user = { id: "u1", email: "person@example.com", name: "Person", avatarUrl: null, plan: "PRO" as const };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  useAuth.setState({ user: null, loading: true, quota: null, quotaLoading: false });
});

describe("loading the session", () => {
  it("signs the person in and loads the quota", async () => {
    get.mockImplementation(async (path: string) => (path === "/auth/session" ? user : { used: 5, limit: 100 }));
    await useAuth.getState().loadSession();
    expect(useAuth.getState().user).toEqual(user);
    expect(useAuth.getState().loading).toBe(false);
    expect(get).toHaveBeenCalledWith("/auth/session", { skipAuth: true });
  });

  it("lands on 'nobody' rather than spinning forever when there is no session", async () => {
    get.mockRejectedValue(new Error("401"));
    await useAuth.getState().loadSession();
    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().loading).toBe(false);
  });

  it("does not fire twice when two things mount at once", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    get.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = useAuth.getState().loadSession();
    const second = useAuth.getState().loadSession();
    resolve!(user);
    await Promise.all([first, second]);
    // One session check between the two mounts. (The quota load that follows a
    // successful session is a separate, deliberate call.)
    const sessionCalls = get.mock.calls.filter(([path]) => path === "/auth/session");
    expect(sessionCalls).toHaveLength(1);
  });

  it("keeps the account after claiming a sign-in, and clears it on sign-out", async () => {
    post.mockResolvedValue({ user });
    await useAuth.getState().claimSignIn("login-1", "secret-1");
    expect(useAuth.getState().user).toEqual(user);

    post.mockResolvedValue({});
    await useAuth.getState().signOut();
    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().quota).toBeNull();
  });

  it("signs out locally even when the server call fails", async () => {
    useAuth.setState({ user });
    post.mockRejectedValue(new Error("offline"));
    await useAuth.getState().signOut();
    expect(useAuth.getState().user).toBeNull();
  });
});
