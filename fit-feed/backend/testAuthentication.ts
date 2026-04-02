// testAuth.ts
import { signUp, login, logout } from "./Authentication.ts";

const testAuth = async () => {
  const testEmail = "testuser@example.com";
  const testPassword = "password123";

  console.log("=== Testing Signup ===");
  const signUpResult = await signUp(testEmail, testPassword);
  if (signUpResult && signUpResult.user) {
    console.log("Signup success:", signUpResult.user.email);
  } else {
    console.log("Signup failed:");
  }

  console.log("=== Testing Login ===");
  const loginResult = await login(testEmail, testPassword);
  if (loginResult && loginResult.user) {
    console.log("Login success:", loginResult.user.email);
  } else {
    console.log("Login failed:");
  }

  console.log("=== Testing Logout ===");
  await logout();
  console.log("Logged out!");
};

testAuth();
// run npx ts-node backend/testAuthentication