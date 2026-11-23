# Catering Hub: putting it online with logins

Each person you invite gets their own account (email + password). They can sign in on any phone, tablet or computer and see the same jobs, payments, prices, menu items and settings. Nobody can sign up on their own, and nobody can see anyone else's data. Not even you can see a customer's data in the calculator; each account is separate.

What's in this folder:

| File | What it does |
|---|---|
| `public/index.html` | The calculator, with the sign-in screen |
| `public/logo.webp`, `public/favicon.png`, `public/apple-touch-icon.png` | Your Catering Hub logo and the browser / home-screen icons |
| `netlify/functions/data.mjs` | Saves and loads each person's data on Netlify, and refuses accounts whose paid access has ended |
| `netlify/functions/access.mjs` | Your Access tab: records payments and access dates (only you can use it) |
| `netlify/functions/stripe-webhook.mjs` | Receives Stripe payments, renews access automatically and adds a notification with the customer's email |
| `netlify/lib/common.mjs` | Shared sign-in, access and payment rules |
| `package.json`, `netlify.toml` | Settings that tell Netlify how to run it |

---

## Part 1. Put it on Netlify (once)

Netlify's drag-and-drop upload only handles plain web pages. This calculator also has a small server part that does the saving, so deploy it with GitHub (easiest) or the Netlify command-line tool.

**Option A: GitHub (no coding tools needed)**
1. Make a free GitHub account if you don't have one, and create a new **private** repository (for example `catering-hub`).
2. On the repository page, choose **Add file → Upload files**, and drag in everything from this folder (`public`, `netlify`, `package.json`, `netlify.toml`, `README.md`). Keep the folder structure. Click **Commit changes**.
3. In Netlify, choose **Add new project → Import an existing project → GitHub**, and pick the repository.
4. Leave the build settings as they are (they come from `netlify.toml`) and click **Deploy**.
5. Optional: under **Domain management**, rename the address (for example `smokeshack-cateringhub.netlify.app`) or connect your own domain.

**Option B: Netlify CLI** (if you have Node.js installed): in this folder run `npx netlify-cli deploy --prod` and follow the prompts.

Netlify Blobs, where the data is saved, turns on by itself. There's nothing to set up for it.

## Part 2. Turn on logins (once)

1. In your Netlify project, open **Identity** and click **Enable Identity**.
2. In the Identity settings, set **Registration** to **Invite only**. *This is the step that stops strangers and forwarded links from getting in.*
3. Leave **External providers** (Google, GitHub and so on) off, so the only way in is an invitation.
4. Optional: under Identity **Emails**, edit the **Invitation** template so the email says it's from your business.
5. Invite yourself first (see Part 3), accept the invitation, and sign in to check that everything works.

The first time you sign in on a device where you used the old cookout calculator, any jobs and prices saved on that device are moved into your account automatically. Each person keeps their own data. Jobs they make don't show up in your account.

## Part 2b. Turn on paid access (once)

This is what locks people out when their paid period ends.

1. In your Netlify project, open **Project configuration → Environment variables** and add:
   - `OWNER_EMAILS` = your own email (the one you sign in with). For more than one owner, separate the emails with commas. Owners always have access and are the only people who see the **Access** tab.
   - Optional: `ACCESS_TIMEZONE` = your time zone, so lockouts happen at midnight your time. The default is `America/Chicago`.
2. Redeploy so the setting takes effect (**Deploys → Trigger deploy → Deploy project**).
3. Sign in and open the **Access** tab (★). Under **Lock screen and defaults**, enter how customers renew (for example your phone number and Cash App) and how many days a payment buys (30). Click **Save**.

If `OWNER_EMAILS` is empty, paid access is switched off and every invited user can get in, like before.

## Part 2c. Take subscription payments online with Stripe (optional)

With this set up, customers tap **Pay now** in Catering Hub. When the payment goes through, their access renews by itself, and the payment appears on your **Access** tab with their email. You can still record cash, Zelle or Cash App payments by hand.

Do this in Stripe's **test mode** first, with test card 4242 4242 4242 4242, then repeat it in live mode.

1. **Create the product.** In Stripe, make a product such as "Catering Hub access" with your price: **$10**.
   - **Monthly subscription (recommended):** choose a *recurring, monthly* price of $10. Customers are charged automatically each month, and their access renews to the end of each paid month (plus one day of grace).
   - **One-time:** choose a *one-time* price. Each payment adds your "Days per payment" (30) to their access.
2. **Create a payment link** for that price. Optional: in the link's after-payment settings, send customers back to your Catering Hub address.
3. **Paste the link into Catering Hub.** Open **Access → Lock screen and defaults**, paste the link (it starts with `https://buy.stripe.com/`), enter the price and the days per payment, and click **Save**. Catering Hub fills in and locks each customer's sign-in email on the payment page, so every payment matches the right account.
4. **Tell Stripe where to send payment notices.** In Stripe, open **Developers → Webhooks** (sometimes called *Event destinations*) and add an endpoint:
   - URL: `https://YOUR-ADDRESS/.netlify/functions/stripe-webhook`
   - Events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`
   - Copy the endpoint's **signing secret** (it starts with `whsec_`).
5. **Give the secret to Netlify.** Add the environment variable `STRIPE_WEBHOOK_SECRET` with that value, then redeploy. The Access tab should now say **Stripe connection: ready**.
6. **Optional: let customers manage their subscription.** In Stripe, turn on the **customer portal** (Billing settings) and copy its login link into the Access tab. Customers then see **Manage my subscription** under *More*, where they can update their card or cancel.
7. **Email notices:** in your Stripe account's notification settings, turn on emails for successful payments. Stripe's emails include the customer's email address.

**What shows up on your Access tab** (a number on the tab means new ones). Each entry includes the customer's email:

| Notice | What happened | What Catering Hub does |
|---|---|---|
| Payment | They paid | Access renewed automatically |
| Failed | A subscription charge failed | Nothing until Stripe's retry succeeds |
| Canceled | They canceled the subscription | Access runs to its end date, then locks |
| Refund | You refunded a payment | Nothing; use **Lock now** or **Set** if needed |
| Unmatched | A payment came in with no matching account | Record it by hand |

Your webhook only accepts messages signed with your Stripe secret. Forged, replayed or duplicate messages are ignored.

## Part 3. Give someone access

1. In your Netlify project, open **Identity → Invite users**.
2. Type their email address and send the invitation.
3. Forward them the message at the bottom of this guide, so they know to expect Netlify's email.

They click the link in the email, choose a password, and they're in. The invitation link works only once.

**Free trial:** a new user's **3-day free trial** starts the first time they sign in. You don't have to do anything. You get a **New trial** notification on the Access tab with their email. During the trial they see a reminder with a **Subscribe** button. When it runs out, they see a "trial ended" screen with the same button, and everything they set up stays saved for when they subscribe. Each email gets only one trial, even if you remove and re-invite them. To change the length or turn trials off (0 days), use **Access → Lock screen and defaults → Free trial for new users**.

4. When they pay (during or after the trial), either:
   - they pay online with **Pay now** (if you set up Stripe), and access turns on by itself, or
   - you open the **Access** tab, enter their email, the days (30), the amount and how they paid, and click **Record payment**. Their access starts today and runs for that many days.

If they pay during the trial, the paid days are added after the trial ends, so they don't lose trial days. If you turn trials off, new users see a lock screen until you record their payment, and they appear on your Access tab as **Not activated**.

## Monthly renewals

- **When someone pays again,** open the **Access** tab and click **+30 days** on their row. If they pay before their time runs out, the days are added to their current end date, so paying early never costs them days. If their access had already ended, the new period starts that day.
- **Five days before access ends,** the customer sees a reminder at the top of the page with your renewal info.
- **When the date passes,** they're locked out starting the next day in your time zone. The lock screen shows your renewal info. Their jobs, prices and settings stay saved and come back as soon as you record a payment.
- **The Access tab** shows everyone's status (Active, Ends in X days, Expired, Not activated), the date their access runs through, when they last used it, and their last payment. You can also **Set** a specific end date, for example for a free month.

## Remove someone's access

- **Pause them** (they stop paying): on the **Access** tab, click **Lock now**. They're locked out right away. Their account and data stay, so you can let them back in later with **+30 days**.
- **Remove them for good:** open Netlify **Identity**, click their name and choose **Delete user**. Then click **Remove** on their row in the Access tab to clear their access record. To let them back in later, invite them again (they'll start with an empty account).

## Tax records

Everyone has a **Taxes** tab. Pick a year to see:

- **Income:** payments recorded on jobs (by payment date), minus the sales tax collected.
- **Expenses:** the costs of jobs whose event date is in that year, each with the Schedule C line it usually goes on: food (cost of goods sold), pans and supplies, fuel, travel, card fees, labor and other costs.
- **Subscription costs:** for customers, what they paid for Catering Hub access (an "other expense").
- **Subscription income:** for you, the subscription payments you received (income).

The tab has these downloads, all CSV files that open in Excel or Google Sheets:
- **Tax summary**
- **Job-by-job detail**
- **Subscription income** (owners only)
- **All subscription payments** (on the Access tab)

**How to get accurate numbers:**
- **Use real costs.** The numbers come from what was entered in each job, so update jobs with what you actually spent and keep receipts.
- **Labor is left out by default.** Check the box only for wages or contractor pay you actually paid to others; your own time isn't deductible.
- **Fees:** card fees are estimated from your card fee %, so use your processor's year-end statement for the exact amount. Stripe's fees on subscription payments are on your Stripe account.

This is a record-keeping aid, not tax advice. Confirm categories with your tax professional.

## If someone forgets their password

They click **Forgot your password?** on the sign-in screen and follow the email. You don't need to do anything.

## Good to know

- **Sharing:** forwarding the web address doesn't give anyone access, and nobody can create their own account. The only way to share is to hand over an email and password. The **Last used** column on the Access tab can help you spot that.
- **Lockout timing:** the lock is checked whenever someone opens the app, saves, comes back to the tab, or every 20 minutes while it's open. Someone in the middle of a session when their access ends is locked out at the next check, and changes made after that point aren't saved.
- **Same job on two devices at once:** if one job is edited on two devices at the same moment, the most recent save of that job wins. Different jobs edited on different devices are kept.
- **No connection:** if a save fails, the page says so at the top and retries by itself. Don't close the page until it says "Saved to your account".
- **Backups:** **More → Download backup** still works, and you can restore a backup into any account.
- **Cost:** Identity, Functions and Blobs are part of Netlify's plans and have usage limits. A calculator used by a handful of people is light use, but check your plan's limits on Netlify's pricing page.

---

## Message to forward to a new user

> **Subject:** Your access to Catering Hub
>
> Hi [Name],
>
> I've set you up with your own account for Catering Hub. It works out food amounts, shopping lists, pricing, estimates and receipts for cookout catering jobs.
>
> **To get started:**
> 1. Look for an email from Netlify with the subject "You've been invited to join…" (check spam if you don't see it). The link only works once.
> 2. Click **Accept the invite** and choose a password (at least 8 characters).
> 3. You're in. Bookmark the page: [your calculator web address]
>
> **You start with a 3-day free trial** the first time you sign in. To keep going after that, tap **Subscribe** in the app.
>
> **After that, it's $10/month**, and your access runs in 30-day periods. You'll see a reminder in the app 5 days before it ends. Tap **Pay now** there (or on the lock screen) to renew online.
>
> **Tax time:** the **Taxes** tab gives you a yearly summary of income and expenses from your jobs, including your Catering Hub subscription, as files you can hand to your tax preparer.
>
> **On any other phone, tablet or computer**, go to the same address and sign in with your email and password. Your jobs, prices and settings will be there.
>
> **Forgot your password?** Click "Forgot your password?" on the sign-in screen.
>
> **Getting around:** go through the tabs in order (Event → Menu → Pricing → Payments → Summary). Set your own prices on **My prices**, and your menu items, business name and defaults on **Setup**. There's a quick guide at the top of Setup.
>
> This account is for you only, so please don't share your login.
>
> Thanks,
> [Your name]
