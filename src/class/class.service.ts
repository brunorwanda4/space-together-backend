import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from 'src/db/db.service';
import { UploadService } from 'src/upload/upload.service';
import { generateCode, generateUsername } from 'src/common/utils/characters.util';
import { CreateClassInput, CreateClassSchema } from './dto/create-class.dto';
import { ClassDto } from './dto/class.dto';
import { ClassTypeOption, Prisma } from 'generated/prisma';
import { UpdateClassInput, UpdateClassSchema } from './dto/update-class.dto';

@Injectable()
export class ClassService {
  constructor(
    private readonly dbService: DbService,
    private readonly uploadService: UploadService,
  ) { }

  async create(createClassDto: CreateClassInput) {
    const validation = CreateClassSchema.safeParse(createClassDto);
    if (!validation.success) {
      throw new BadRequestException('Invalid class data provided');
    }

    const { name, schoolId, creatorId, classTeacherId: primaryTeacherId, image: initialImage, username, ...rest } = validation.data;
    if (!creatorId && !schoolId && !primaryTeacherId) {
      throw new BadRequestException("Invalid class creation - missing required connections");
    }

    let imageUrl = initialImage;

    try {
      // Check if school exists if schoolId is provided
      if (schoolId) {
        const school = await this.dbService.school.findUnique({ where: { id: schoolId } });
        if (!school) {
          throw new NotFoundException(`School with ID "${schoolId}" not found`);
        }
      }

      // Check if creator exists if creatorId is provided
      if (creatorId) {
        const creator = await this.dbService.user.findUnique({ where: { id: creatorId } });
        if (!creator) {
          throw new NotFoundException(`User with ID "${creatorId}" not found`);
        }
        // Optional: Add role check for creator if only certain roles can create classes
        if (creator.role !== "TEACHER" && creator.role !== "SCHOOL_ADMIN" && creator.role !== "ADMIN") {
          throw new BadRequestException('You do not have permission to create a class');
        }
      }

      // Check if primary teacher exists if primaryTeacherId is provided
      if (primaryTeacherId) {
        const teacher = await this.dbService.teacher.findUnique({
          where: { id: primaryTeacherId },
          include: { user: true }
        });
        if (!teacher) {
          throw new NotFoundException(`Teacher with ID "${primaryTeacherId}" not found`);
        }
      }

      // Upload image if it's a base64 string
      if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('data:image')) {
        try {
          const uploaded = await this.uploadService.uploadBase64Image(imageUrl, 'class-images');
          imageUrl = uploaded.secure_url;
        } catch (uploadError) {
          console.error('Image upload failed:', uploadError);
          throw new BadRequestException('Failed to upload class image');
        }
      }

      const data: Prisma.ClassCreateInput = {
        name,
        username: username || generateUsername(name),
        classImage: imageUrl,
        classCode: generateCode(),
        ...rest,
        classType: rest.classType || 'MAIN_SCHOOL_CLASS',
      };

      if (schoolId) data.school = { connect: { id: schoolId } };
      if (creatorId) data.creator = { connect: { id: creatorId } };
      if (primaryTeacherId) data.primaryTeacher = { connect: { id: primaryTeacherId } };

      const createdClass = await this.dbService.class.create({
        data,
        include: {
          school: true,
          creator: true,
          primaryTeacher: true
        }
      });

      const { classCode, ...safeClass } = createdClass;
      return safeClass;

    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('username')) {
          throw new BadRequestException('Class with this username already exists');
        }
        if (error.meta?.target?.includes('classCode')) {
          throw new BadRequestException('Generated class code is not unique, please try again');
        }
      }
      throw new BadRequestException({
        message: 'Something went wrong while creating the class',
        error: error.message
      });
    }
  }

  async findAll(schoolId?: string, creatorId?: string, classType?: ClassTypeOption) {
    try {
      const where: Prisma.ClassWhereInput = {};

      if (schoolId) {
        where.schoolId = schoolId;
      }

      if (creatorId) {
        where.creatorId = creatorId;
      }

      if (classType) {
        where.classType = classType;
      }

      return await this.dbService.class.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          school: {
            select: {
              id: true,
              name: true,
              logo: true
            }
          },
          primaryTeacher: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  image: true
                }
              }
            }
          }
        }
      });

    } catch (error) {
      console.error('Error retrieving classes:', error);
      throw new NotFoundException({
        message: 'Something went wrong while retrieving classes',
        error: error.message,
      });
    }
  }

  async findAllBySchoolIdNeededData(schoolId: string) {
    try {
      const classes = await this.dbService.class.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          classImage: true,
          classType: true,
          _count: {
            select: {
              members: true,
            }
          },
          primaryTeacher: {
            select: {
              user: {
                select: {
                  fullName: true,
                  image: true
                }
              }
            }
          }
        }
      });

      return classes;
    } catch (error) {
      console.error('Error retrieving classes by school ID:', error);
      throw new NotFoundException({
        message: 'Something went wrong while retrieving classes by school ID',
        error: error.message,
      });
    }
  }

  async findOne(id?: string, username?: string, code?: string) {
    if (!id && !code && !username) {
      throw new BadRequestException('You must provide id, code, or username to find a class');
    }

    const where = id
      ? { id }
      : code
        ? { classCode: code }
        : { username };

    try {
      const classFound = await this.dbService.class.findUnique({
        where,
        include: {
          courseContentModules: {
            select: {
              id: true,
              title: true,
              orderInClass: true,
              learningMaterials: {
                select: {
                  id: true,
                  title: true,
                  type: true
                }
              }
            }
          },
          members: {
            include: {
              user: {
                select: {
                  fullName: true,
                  image: true,
                  email: true,
                  id: true,
                }
              },
              teacherRole: {
                include: {
                  user: {
                    select: {
                      fullName: true,
                      image: true
                    }
                  }
                }
              }
            }
          },
          school: {
            select: {
              username: true,
              name: true,
              logo: true,
              websiteUrl: true,
              id: true,
              contact: true
            }
          },
          primaryTeacher: {
            include: {
              user: {
                select: {
                  fullName: true,
                  image: true,
                  email: true
                }
              }
            }
          }
        }
      });

      if (!classFound) {
        const identifier = id || code || username;
        throw new NotFoundException(`Class not found with identifier: ${identifier}`);
      }

      if (classFound.classType === "PRIVATE_TUTORING") {
        const { classCode, ...safeClass } = classFound;
        return safeClass;
      }

      return classFound;

    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Error retrieving class:', error);
      throw new NotFoundException({
        message: 'Something went wrong while retrieving class',
        error: error.message,
      });
    }
  }

  async update(id: string, updateClassDto: UpdateClassInput): Promise<ClassDto> {
    const validation = UpdateClassSchema.safeParse(updateClassDto);
    if (!validation.success) {
      throw new BadRequestException('Invalid class update data provided');
    }

    const updateData = validation.data;

    try {
      const existingClass = await this.dbService.class.findUnique({ where: { id } });
      if (!existingClass) {
        throw new NotFoundException(`Class with ID "${id}" not found`);
      }

      // Handle image update
      if (updateData.image && typeof updateData.image === 'string' && updateData.image.startsWith('data:image')) {
        try {
          // Delete old image if it exists
          if (existingClass.classImage) {
            await this.uploadService.deleteImage(existingClass.classImage);
          }

          const uploaded = await this.uploadService.uploadBase64Image(updateData.image, 'class-images');
          updateData.image = uploaded.secure_url;
        } catch (uploadError) {
          console.error('Image upload for update failed:', uploadError);
          throw new BadRequestException('Failed to upload updated class image');
        }
      } else if (updateData.image === null || updateData.image === '') {
        // Handle case where image is explicitly set to null or empty string to remove it
        if (existingClass.classImage) {
          await this.uploadService.deleteImage(existingClass.classImage);
        }
        updateData.image = null;
      }

      // Handle primary teacher update
      if (updateData.classTeacherId) {
        const teacher = await this.dbService.teacher.findUnique({
          where: { id: updateData.classTeacherId },
          include: { user: true }
        });
        if (!teacher) {
          throw new NotFoundException(`Teacher with ID "${updateData.classTeacherId}" not found`);
        }
      }

      const updatedClass = await this.dbService.class.update({
        where: { id },
        data: {
          schoolId: updateData.schoolId,
          creatorId: updateClassDto.creatorId,
          classCode: updateClassDto.code,
          name: updateClassDto.name,
          username: updateClassDto.username,
          classImage: updateData.image,
          classType: updateData.classType === null ? undefined : updateData.classType,

        },
        include: {
          school: true,
          primaryTeacher: {
            include: {
              user: true
            }
          }
        }
      });

      return updatedClass as unknown as ClassDto;

    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundException(`Class with ID "${id}" not found`);
      }
      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('username')) {
          throw new BadRequestException('Class with this username already exists');
        }
      }
      console.error(`Error updating class with ID "${id}":`, error);
      throw new BadRequestException(`Something went wrong while updating class with ID "${id}"`);
    }
  }

  async remove(id: string) {
    try {
      const classToDelete = await this.dbService.class.findUnique({ where: { id } });
      if (!classToDelete) {
        throw new NotFoundException(`Class with ID "${id}" not found`);
      }

      // Delete associated image if it exists
      if (classToDelete.classImage) {
        await this.uploadService.deleteImage(classToDelete.classImage);
      }

      await this.dbService.class.delete({
        where: { id },
      });

      return { message: `Class with ID "${id}" has been deleted successfully` };

    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundException(`Class with ID "${id}" not found`);
      }
      console.error(`Error removing class with ID "${id}":`, error);
      throw new BadRequestException(`Something went wrong while removing class with ID "${id}"`);
    }
  }
}