import { BadRequestException, Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { CreateSchoolDto, CreateSchoolSchema, schoolTypeDto, SchoolMembersDto, curriculumEnumDto } from './dto/school.dto';
import { SchoolAcademicCreationDto, SchoolAcademicDto, SchoolAcademicSchema } from './dto/school-academic.dto';
import { DbService } from 'src/db/db.service';
import { generateCode, generateUsername } from 'src/common/utils/characters.util';
import { UploadService } from 'src/upload/upload.service';
import { Prisma, SchoolJoinRequestRole } from 'generated/prisma';
import { SchoolAdministrationDto, SchoolAdministrationSchema } from './dto/school-administration.dto';
import { sendAdministrationJoinRequestsDto } from 'src/join-school-request/dto/join-school-request.dto';
import { hashCode } from 'src/common/utils/hash.util';
import { UpdateSchoolDto, UpdateSchoolSchema } from './dto/update.dto';

@Injectable()
export class SchoolService {
    constructor(
        private readonly dbService: DbService,
        private readonly uploadService: UploadService,
    ) { }

    async create(createSchoolDto: CreateSchoolDto,) {
        const validation = CreateSchoolSchema.safeParse(createSchoolDto);
        if (!validation.success) {
            throw new BadRequestException('Invalid school data provided');
        }
        const { name, creatorId, logo, username: initialUsername, ...rest } = validation.data;
        let username = initialUsername;
        try {
            const [creator, getSchoolByUsername] = await Promise.all([
                this.dbService.user.findUnique({ where: { id: creatorId } }),
                this.dbService.school.findUnique({ where: { username } })
            ]);

            if (!creator || (creator.role !== "SCHOOL_ADMIN" && creator.role !== "ADMIN")) {
                throw new BadRequestException('You cannot create a school')
            }

            if (getSchoolByUsername) {
                username = generateUsername(name)
            }
            let imageUrl = logo;
            if (logo && typeof logo === 'string' && logo.startsWith('data:image')) {
                const uploaded = await this.uploadService.uploadBase64Image(logo, 'logos');
                imageUrl = uploaded.secure_url;
            }
            const studentInvitationCode = await hashCode(generateCode());
            const teacherInvitationCode = await hashCode(generateCode());
            const staffInvitationCode = await hashCode(generateCode());
            const parentInvitationCode = await hashCode(generateCode());
            return await this.dbService.school.create({
                data: {
                    name,
                    creatorId,
                    logo: imageUrl,
                    username,
                    studentInvitationCode,
                    teacherInvitationCode,
                    staffInvitationCode,
                    parentInvitationCode,
                    schoolType
                    ...rest,
                }
            })
        } catch (error) {
            if (error.code === 'P2002') {
                if (error.meta?.target?.includes('username')) {
                    throw new BadRequestException('School with this username already exists.');
                }
                if (error.meta?.target?.includes('code')) {
                    throw new BadRequestException('Generated school code is not unique, please try again.');
                }
            }
            throw new BadRequestException({
                message: 'Something went wrong while creating the school',
                error: error.message,
            });
        }
    }

    async findAll(schoolType?: schoolTypeDto, schoolMembers?: SchoolMembersDto, creatorId?: string) {
        try {
            const where: any = {};

            if (schoolType) {
                where.schoolType = schoolType;
            }

            if (creatorId) {
                where.creatorId = creatorId;
            }

            const schools = await this.dbService.school.findMany({
                where,
                orderBy: { createdAt: 'desc' }
            });

            // Omit the invitation codes from the returned objects
            const safeSchool = schools.map(({
                studentInvitationCode,
                teacherInvitationCode,
                staffInvitationCode,
                parentInvitationCode,
                ...rest
            }) => rest);
            return safeSchool;
        } catch (error) {
            throw new NotFoundException({
                message: 'Something went wrong while retrieving schools',
                error: error.message,
            });
        }
    }

    async findOne(id?: string, username?: string,) {
        if (!id && !username) {
            throw new BadRequestException('You must provide id or username to find a school');
        }

        const where = id ? { id } : { username };

        try {
            const school = await this.dbService.school.findUnique({
                where,
                include: {
                    staffMembers: {
                        select: {
                            userId: true,
                            staffFullName: true,
                            staffImage: true,
                            staffEmail: true,
                            id: true
                        }
                    },
                    teachers: {
                        select : {
                            teacherBio : true,
                            userId : true,
                            teacherEmail : true,
                            id : true,
                            teacherImage : true

                        }
                    },
                    students: true,
                    joinRequests: true
                }
            });

            if (!school) {
                const identifier = id || username;
                throw new NotFoundException(`School not found with identifier: ${identifier}`);
            }
            return school;
        } catch (error) {
            console.error('Error retrieving school:', error);
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new NotFoundException({
                message: 'Something went wrong while retrieving school',
                error: error.message,
            });
        }
    }

    async update(schoolId: string, updateSchoolDto: UpdateSchoolDto,) {
        const validation = UpdateSchoolSchema.safeParse(updateSchoolDto);
        if (!validation.success) {
            console.error("Validation Errors:", validation.error.flatten().fieldErrors);
            throw new BadRequestException({
                message: 'Invalid school data provided for update',
                errors: validation.error.flatten().fieldErrors
            });
        }

        const { logo, username: newUsername, name, ...rest } = validation.data;

        try {
            const existingSchool = await this.dbService.school.findUnique({ where: { id: schoolId } });
            if (!existingSchool) {
                throw new BadRequestException('School not found.');
            }

            let finalUsername = existingSchool.username;
            if (newUsername && newUsername !== existingSchool.username) {
                const schoolWithNewUsername = await this.dbService.school.findUnique({ where: { username: newUsername } });
                if (schoolWithNewUsername && schoolWithNewUsername.id !== schoolId) {
                    throw new BadRequestException(`Username '${newUsername}' is already taken.`);
                }
                finalUsername = newUsername;
            }

            let imageUrl = existingSchool.logo;
            if (logo && typeof logo === 'string') {
                if (logo.startsWith('data:image')) {
                    const uploaded = await this.uploadService.uploadBase64Image(logo, 'logos');
                    imageUrl = uploaded.secure_url;
                } else if (logo.startsWith('http://') || logo.startsWith('https://')) {
                    imageUrl = logo;
                } else if (logo === "") {
                    imageUrl = null;
                }
            }

            const dataToUpdate: any = {
                ...rest,
                username: finalUsername,
                logo: imageUrl,
            };

            if (name !== undefined) {
                dataToUpdate.name = name;
            }

            for (const key in dataToUpdate) {
                if (dataToUpdate[key] === undefined) {
                    delete dataToUpdate[key];
                }
            }

            if (Object.keys(dataToUpdate).length === 0) {
                console.log("No changes to apply for school:", schoolId);
                return existingSchool;
            }

            return await this.dbService.school.update({
                where: { id: schoolId },
                data: {
                    ...dataToUpdate,
                    updatedAt: new Date(),
                },
            });

        } catch (error: any) {
            if (error.code === 'P2002') {
                const target = error.meta?.target;
                if (target?.includes('username')) {
                    throw new BadRequestException('School with this username already exists.');
                }
            }
            console.error("Update School Error:", error);
            throw new BadRequestException({
                message: error.message || 'Something went wrong while updating the school',
                error: error.message,
            });
        }
    }

    async setupAcademicStructure(
        schoolAcademicDto: SchoolAcademicDto,
    ): Promise<SchoolAcademicCreationDto> {
        const validation = SchoolAcademicSchema.safeParse(schoolAcademicDto);
        if (!validation.success) {
            console.error("Zod validation failed:", validation.error.format());
            throw new BadRequestException('Invalid school academic data provided');
        }

        const {
            schoolId,
            primarySubjectsOffered,
            oLevelCoreSubjects,
            aLevelSubjectCombination,
            tvetSpecialization,
        } = validation.data;

        try {
            const school = await this.dbService.school.findUnique({
                where: { id: schoolId },
                select: { id: true, name: true },
            });

            if (!school) {
                throw new NotFoundException(`School with ID "${schoolId}" not found`);
            }

            const currentYear = new Date().getFullYear();
            const academicYear = `${currentYear}-${currentYear + 1}`;

            const classesToCreate: Prisma.ClassCreateManyInput[] = [];
            const modulesByClass: { className: string; modules: Prisma.CourseContentModuleCreateManyInput[] }[] = [];

            // Primary Education (6 classes: P1 to P6)
            if (primarySubjectsOffered && primarySubjectsOffered.length > 0) {
                for (let i = 1; i <= 6; i++) {
                    const level = `P${i}`;
                    const className = `${level} ${school.name.replace(/\s+/g, '')} ${academicYear}`;
                    const classUsername = generateUsername(className);

                    classesToCreate.push({
                        name: className,
                        username: classUsername,
                        schoolId: school.id,
                        classCode: generateCode(),
                        classType: 'MAIN_SCHOOL_CLASS',
                    });

                    const classModules = primarySubjectsOffered.map(subjectName => ({
                        title: subjectName,
                        moduleCode: generateCode(),
                        moduleType: 'CORE_CONTENT',
                    }));

                    modulesByClass.push({
                        className,
                        modules: classModules
                    });
                }
            }

            // Ordinary Level (3 classes: S1 to S3)
            if (oLevelCoreSubjects && oLevelCoreSubjects.length > 0) {
                for (let i = 1; i <= 3; i++) {
                    const level = `S${i}`;
                    const className = `${level} ${school.name.replace(/\s+/g, '')} ${academicYear}`;
                    const classUsername = generateUsername(className);

                    classesToCreate.push({
                        name: className,
                        username: classUsername,
                        schoolId: school.id,
                        classCode: generateCode(),
                        classType: 'MAIN_SCHOOL_CLASS',
                    });

                    const classModules = oLevelCoreSubjects.map(subjectName => ({
                        title: subjectName,
                        moduleCode: generateCode(),
                        moduleType: 'CORE_CONTENT',
                    }));

                    if (validation.data.oLevelOptionSubjects && validation.data.oLevelOptionSubjects.length > 0) {
                        validation.data.oLevelOptionSubjects.forEach(subjectName => {
                            classModules.push({
                                title: subjectName,
                                moduleCode: generateCode(),
                                moduleType: 'SUPPLEMENTARY',
                            });
                        });
                    }

                    modulesByClass.push({
                        className,
                        modules: classModules
                    });
                }
            }

            // Advanced Level (S4, S5, S6 for each combination)
            if (aLevelSubjectCombination && aLevelSubjectCombination.length > 0) {
                const aLevelLevels = [4, 5, 6];

                aLevelSubjectCombination.forEach(combination => {
                    aLevelLevels.forEach(levelNumber => {
                        const level = `S${levelNumber}`;
                        const className = `${level} ${combination} ${school.name.replace(/\s+/g, '')} ${academicYear}`;
                        const classUsername = generateUsername(className);

                        classesToCreate.push({
                            name: className,
                            username: classUsername,
                            schoolId: school.id,
                            classCode: generateCode(),
                            classType: 'MAIN_SCHOOL_CLASS',
                        });

                        const classModules = [{
                            title: combination,
                            moduleCode: generateCode(),
                            moduleType: 'CORE_CONTENT',
                        }];

                        if (validation.data.aLevelOptionSubjects && validation.data.aLevelOptionSubjects.length > 0) {
                            validation.data.aLevelOptionSubjects.forEach(subjectName => {
                                classModules.push({
                                    title: subjectName,
                                    moduleCode: generateCode(),
                                    moduleType: 'SUPPLEMENTARY',
                                });
                            });
                        }

                        modulesByClass.push({
                            className,
                            modules: classModules
                        });
                    });
                });
            }

            // TVET (L3, L4, L5 for each specialization)
            if (tvetSpecialization && tvetSpecialization.length > 0) {
                const tvetLevels = ['L3', 'L4', 'L5'];
                tvetLevels.forEach(level => {
                    tvetSpecialization.forEach(specializationName => {
                        const className = `${level} ${specializationName.replace(/\s+/g, '')} ${school.name.replace(/\s+/g, '')} ${academicYear}`;
                        const classUsername = generateUsername(className);

                        classesToCreate.push({
                            name: className,
                            username: classUsername,
                            schoolId: school.id,
                            classCode: generateCode(),
                            classType: 'MAIN_SCHOOL_CLASS',
                        });

                        const classModules = [{
                            title: specializationName,
                            moduleCode: generateCode(),
                            moduleType: 'CORE_CONTENT',
                        }];

                        if (validation.data.tvetOptionSubjects && validation.data.tvetOptionSubjects.length > 0) {
                            validation.data.tvetOptionSubjects.forEach(subjectName => {
                                classModules.push({
                                    title: subjectName,
                                    moduleCode: generateCode(),
                                    moduleType: 'SUPPLEMENTARY',
                                });
                            });
                        }

                        modulesByClass.push({
                            className,
                            modules: classModules
                        });
                    });
                });
            }

            let createdClassesCount = 0;
            if (classesToCreate.length > 0) {
                const result = await this.dbService.class.createMany({
                    data: classesToCreate,
                });
                createdClassesCount = result.count;
            }

            const classNamesCreated = classesToCreate.map(c => c.name);
            const classesInDb = await this.dbService.class.findMany({
                where: {
                    schoolId: school.id,
                    name: { in: classNamesCreated }
                },
                select: { id: true, name: true }
            });

            const finalModuleInstancesToCreate: Prisma.CourseContentModuleCreateManyInput[] = [];

            modulesByClass.forEach(classModuleData => {
                const classInDb = classesInDb.find(c => c.name === classModuleData.className);
                if (classInDb) {
                    classModuleData.modules.forEach(module => {
                        finalModuleInstancesToCreate.push({
                            ...module,
                            classId: classInDb.id,
                        });
                    });
                }
            });

            let createdModulesCount = 0;
            if (finalModuleInstancesToCreate.length > 0) {
                const result = await this.dbService.courseContentModule.createMany({
                    data: finalModuleInstancesToCreate,
                });
                createdModulesCount = result.count;
            }

            const academicProfileData: Prisma.SchoolAcademicProfileInput = {
                academicYears: [],
                gradeLevels: [],
                subjectAreas: [],
                curriculumFrameworks: ['REB'],
                defaultGradingScaleDescription: validation.data.defaultGradingScaleDescription,
                primarySubjectsOffered: validation.data.primarySubjectsOffered ?? [],
                primaryPassMark: validation.data.primaryPassMark,
                oLevelCoreSubjects: validation.data.oLevelCoreSubjects ?? [],
                oLevelOptionSubjects: validation.data.oLevelOptionSubjects ?? [],
                oLevelExaminationTypes: validation.data.oLevelExaminationTypes ?? [],
                oLevelAssessment: validation.data.oLevelAssessment ?? [],
                aLevelSubjectCombination: validation.data.aLevelSubjectCombination ?? [],
                aLevelOptionSubjects: validation.data.aLevelOptionSubjects ?? [],
                aLevelPassMark: validation.data.aLevelPassMark,
                tvetSpecialization: validation.data.tvetSpecialization ?? [],
                tvetOptionSubjects: validation.data.tvetOptionSubjects ?? [],
            };

            await this.dbService.school.update({
                where: { id: schoolId },
                data: {
                    academicProfile: academicProfileData,
                    totalClasses: createdClassesCount,
                    totalModules: createdModulesCount,
                },
            });

            return { totalClasses: createdClassesCount, totalModule: createdModulesCount };

        } catch (error) {
            console.error("Error in setupAcademicStructure:", error);
            if (error instanceof NotFoundException || error instanceof BadRequestException) {
                throw error;
            }
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const target = error.meta?.target as string[] | string | undefined;
                let fieldMessage = "a generated value";
                if (target && Array.isArray(target) && target.length > 0) {
                    fieldMessage = target.join(', ');
                } else if (typeof target === 'string') {
                    fieldMessage = target;
                }
                throw new BadRequestException(`A unique constraint violation occurred on ${fieldMessage}. Please try again or check data.`);
            }

            throw new InternalServerErrorException('Something went wrong while setting up the school academic structure.', error.message);
        }
    }

    async sendAdministrationJoinRequests(schoolAdministrationDto: SchoolAdministrationDto): Promise<sendAdministrationJoinRequestsDto> {
        const validation = SchoolAdministrationSchema.safeParse(schoolAdministrationDto);
        if (!validation.success) {
            throw new BadRequestException('Invalid school administration data provided');
        }
        const { schoolId, headmasterName, headmasterEmail, headmasterPhone,
            DirectorOfStudies, principalEmail, principalPhone,
            additionalAdministration } = validation.data;

        try {
            const school = await this.dbService.school.findUnique({ where: { id: schoolId } });

            if (!school) {
                throw new NotFoundException(`School with ID "${schoolId}" not found`);
            }

            const requestsToCreate: Prisma.SchoolJoinRequestCreateManyInput[] = [];

            if (headmasterEmail) {
                requestsToCreate.push({
                    schoolId: school.id,
                    requestedRole: 'TEACHER',
                    requesterName: headmasterName,
                    requesterEmail: headmasterEmail,
                    requesterPhone: headmasterPhone,
                    userId: null,
                });
            }

            if (principalEmail) {
                requestsToCreate.push({
                    schoolId: school.id,
                    requestedRole: 'TEACHER',
                    requesterName: DirectorOfStudies,
                    requesterEmail: principalEmail,
                    requesterPhone: principalPhone,
                    userId: null,
                });
            }

            if (additionalAdministration && additionalAdministration.length > 0) {
                additionalAdministration.forEach(admin => {
                    if (admin.email) {
                        requestsToCreate.push({
                            schoolId: school.id,
                            requestedRole: admin.role as SchoolJoinRequestRole,
                            requesterName: admin.name,
                            requesterEmail: admin.email,
                            requesterPhone: admin.phone,
                            userId: null,
                        });
                    }
                });
            }

            if (requestsToCreate.length === 0) {
                throw new BadRequestException('No valid administration contact emails provided to send join requests.');
            }

            let createdCount = 0;
            try {
                const result = await this.dbService.schoolJoinRequest.createMany({
                    data: requestsToCreate,
                });
                createdCount = result.count;
            } catch (error) {
                console.error('Error during bulk creation of administration join requests:', error);
                throw new InternalServerErrorException('Something went wrong during the bulk creation of administration join requests.');
            }
            return {
                attempted: requestsToCreate.length,
                created: createdCount,
                message: `Attempted to create ${requestsToCreate.length} administration join requests.`
            };

        } catch (error) {
            if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof InternalServerErrorException) {
                throw error;
            }
            console.error('Unexpected error in sendAdministrationJoinRequests:', error);
            throw new InternalServerErrorException('An unexpected error occurred while processing administration join requests.');
        }
    }
}