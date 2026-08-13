// Shared type + secret utility for the Promotions HMAC signers used by
// click tracking (see services/promotions.ts — signDeliveryClickToken,
// signPromoClickToken). Opt-out URLs no longer use HMAC signing —
// they're plain /opt-out landing pages where the client enters their
// own email/phone (mirrors what real ESPs like Mailchimp do).

export type PromoChannel = "email" | "sms";
