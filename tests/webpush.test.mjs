// Verifies Web Push encryption against the worked example in RFC 8291, Appendix A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptPayload, b64u } from "../functions/api/webpush.js";

test("aes128gcm encryption matches RFC 8291 Appendix A byte for byte", async () => {
  const asPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const asPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const uaPublic = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const auth = "BTBZMqHH6r4Tts7J_aSIgg";
  const salt = "DGv6ra1nlYgDCS1FRnbzlw";
  const expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

  const pub = b64u.decode(asPublic);
  const jwk = { kty: "EC", crv: "P-256", d: asPrivate, x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);

  const body = await encryptPayload(
    { keys: { p256dh: uaPublic, auth } },
    "When I grow up, I want to be a watermelon",
    { localKeys: { privateKey, publicKey }, salt: b64u.decode(salt) },
  );
  assert.equal(b64u.encode(body), expected);
});
