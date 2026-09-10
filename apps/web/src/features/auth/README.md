## Auth and workspace administration

F01 provides registration/login, invitation acceptance, workspace onboarding and the member/team
settings screen. The browser API client uses credentialed HttpOnly cookies and never handles raw
access tokens. Authorization remains enforced by API application policy; hidden controls are only a
usability aid.
