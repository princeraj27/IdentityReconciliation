import { Router, Request, Response } from "express";
import { PrismaClient, Contact } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

interface IdentifyRequest {
    email?: string | null;
    phoneNumber?: string | null;
}

interface ConsolidatedContact {
    primaryContatctId: number;
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
}

/**
 * Given a primary contact ID, fetch all related contacts and build the
 * consolidated response. Primary contact's info always comes first.
 */
async function buildConsolidatedResponse(
    primaryId: number
): Promise<ConsolidatedContact> {
    const primary = await prisma.contact.findUnique({ where: { id: primaryId } });
    if (!primary) throw new Error(`Primary contact ${primaryId} not found`);

    const secondaries = await prisma.contact.findMany({
        where: { linkedId: primaryId, linkPrecedence: "secondary" },
        orderBy: { createdAt: "asc" },
    });

    const emails: string[] = [];
    const phoneNumbers: string[] = [];
    const secondaryContactIds: number[] = [];

    // Primary first
    if (primary.email) emails.push(primary.email);
    if (primary.phoneNumber) phoneNumbers.push(primary.phoneNumber);

    // Then secondaries
    for (const sec of secondaries) {
        secondaryContactIds.push(sec.id);
        if (sec.email && !emails.includes(sec.email)) emails.push(sec.email);
        if (sec.phoneNumber && !phoneNumbers.includes(sec.phoneNumber))
            phoneNumbers.push(sec.phoneNumber);
    }

    return {
        primaryContatctId: primaryId,
        emails,
        phoneNumbers,
        secondaryContactIds,
    };
}

/**
 * Find the root primary contact for a given contact.
 * Follows the linkedId chain upward.
 */
async function findPrimary(contact: Contact): Promise<Contact> {
    let current = contact;
    while (
        current.linkPrecedence === "secondary" &&
        current.linkedId !== null
    ) {
        const parent = await prisma.contact.findUnique({
            where: { id: current.linkedId },
        });
        if (!parent) break;
        current = parent;
    }
    return current;
}

router.post("/", async (req: Request, res: Response) => {
    try {
        const { email, phoneNumber }: IdentifyRequest = req.body;

        // Normalize: treat empty strings and "null"/"undefined" as null
        const normEmail = email && email.trim() !== "" ? email.trim() : null;
        const normPhone =
            phoneNumber && String(phoneNumber).trim() !== ""
                ? String(phoneNumber).trim()
                : null;

        // At least one must be provided
        if (!normEmail && !normPhone) {
            return res.status(400).json({
                error: "At least one of email or phoneNumber must be provided",
            });
        }

        // ---- Step 1: Find all contacts that match on email OR phone ----
        const matchConditions: any[] = [];
        if (normEmail) matchConditions.push({ email: normEmail });
        if (normPhone) matchConditions.push({ phoneNumber: normPhone });

        const matchingContacts = await prisma.contact.findMany({
            where: { OR: matchConditions },
            orderBy: { createdAt: "asc" },
        });

        // ---- Step 2: No matches → create new primary contact ----
        if (matchingContacts.length === 0) {
            const newContact = await prisma.contact.create({
                data: {
                    email: normEmail,
                    phoneNumber: normPhone,
                    linkPrecedence: "primary",
                },
            });

            return res.status(200).json({
                contact: {
                    primaryContatctId: newContact.id,
                    emails: normEmail ? [normEmail] : [],
                    phoneNumbers: normPhone ? [normPhone] : [],
                    secondaryContactIds: [],
                },
            });
        }

        // ---- Step 3: Resolve all matched contacts to their primaries ----
        const primarySet = new Map<number, Contact>();
        for (const contact of matchingContacts) {
            const primary = await findPrimary(contact);
            primarySet.set(primary.id, primary);
        }

        const primaries = Array.from(primarySet.values()).sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );

        // The oldest primary wins
        const truePrimary = primaries[0];

        // ---- Step 4: If multiple primaries found, merge them ----
        if (primaries.length > 1) {
            for (let i = 1; i < primaries.length; i++) {
                const otherPrimary = primaries[i];

                // Turn the newer primary into a secondary of the oldest
                await prisma.contact.update({
                    where: { id: otherPrimary.id },
                    data: {
                        linkedId: truePrimary.id,
                        linkPrecedence: "secondary",
                        updatedAt: new Date(),
                    },
                });

                // Reassign all secondaries of the other primary to the true primary
                await prisma.contact.updateMany({
                    where: { linkedId: otherPrimary.id },
                    data: {
                        linkedId: truePrimary.id,
                        updatedAt: new Date(),
                    },
                });
            }
        }

        // ---- Step 5: Check if we need to create a new secondary contact ----
        // A secondary is needed if the incoming request has new info not in the group
        const allGroupContacts = await prisma.contact.findMany({
            where: {
                OR: [
                    { id: truePrimary.id },
                    { linkedId: truePrimary.id },
                ],
            },
            orderBy: { createdAt: "asc" },
        });

        const existingEmails = new Set(
            allGroupContacts.map((c) => c.email).filter(Boolean)
        );
        const existingPhones = new Set(
            allGroupContacts.map((c) => c.phoneNumber).filter(Boolean)
        );

        const hasNewEmail = normEmail && !existingEmails.has(normEmail);
        const hasNewPhone = normPhone && !existingPhones.has(normPhone);

        // Check if an exact duplicate row already exists
        const exactDuplicateExists = allGroupContacts.some(
            (c) =>
                (normEmail ? c.email === normEmail : c.email === null) &&
                (normPhone ? c.phoneNumber === normPhone : c.phoneNumber === null)
        );

        if ((hasNewEmail || hasNewPhone) && !exactDuplicateExists) {
            await prisma.contact.create({
                data: {
                    email: normEmail,
                    phoneNumber: normPhone,
                    linkedId: truePrimary.id,
                    linkPrecedence: "secondary",
                },
            });
        }

        // ---- Step 6: Build and return consolidated response ----
        const response = await buildConsolidatedResponse(truePrimary.id);
        return res.status(200).json({ contact: response });
    } catch (error) {
        console.error("Error in /identify:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
